import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as elasticloadbalancingv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { Construct } from "constructs";
import * as dotenv from "dotenv";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53aliases from "aws-cdk-lib/aws-route53-targets";

// Load environment variables from .env file
dotenv.config();

/**
 * Properties for the VPC Infrastructure Stack
 *
 * This stack creates the foundational VPC infrastructure for the AI chatbot
 * including networking, security groups, and load balancer components
 */
export interface VpcInfrastructureStackProps extends cdk.StackProps {
  /** Optional environment name for resource naming */
  environmentName?: string;
  /** CIDR block for the VPC (default: 172.16.0.0/16) */
  vpcCidr?: string;
  /** Maximum number of Availability Zones to use (default: 2) - MUST be at least 2 for ALB */
  maxAzs?: number;
  /** CIDR mask for subnet division (default: 24) */
  cidrMask?: number;
  /** Port used by the LLM service (default: 50051) */
  llmServicePort?: number;
  /** Prefix for SSM parameters related to LLM service */
  serviceDiscoveryPrefix?: string;
  /** Prefix for SSM parameters related to WebSocket Lambda */
  webSocketLambdaPrefix?: string;
}

export class VpcInfrastructureStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props?: VpcInfrastructureStackProps
  ) {
    super(scope, id, props);

    // Use provided values or defaults
    const vpcCidr = props?.vpcCidr || "172.16.0.0/16";
    // IMPORTANT: Changed default maxAzs to 2 - ALB requires at least 2 AZs
    const maxAzs = props?.maxAzs || 2;
    if (maxAzs < 2) {
      throw new Error("maxAzs must be at least 2 for ALB deployment");
    }

    const cidrMask = props?.cidrMask || 24;
    const llmServicePort = props?.llmServicePort || 50051;
    const serviceDiscoveryPrefix =
      props?.serviceDiscoveryPrefix || "/deepseek-llm-service";
    const webSocketLambdaPrefix =
      props?.webSocketLambdaPrefix || "/websocket-lambda-deepseek";

    // Import the ACM certificate by ARN from environment variables
    const acmCertificateArn = process.env.DEEPSEEK_ACM_ARN;
    if (!acmCertificateArn) {
      throw new Error("DEEPSEEK_ACM_ARN environment variable is required");
    }

    // Certificate domain name
    const certificateDomain = "deepseek.jonathanmau.com";

    const certificate = acm.Certificate.fromCertificateArn(
      this,
      "DeepseekCertificate",
      acmCertificateArn
    );

    /**
     * Create a VPC with both public and private subnets across multiple AZs
     * - Public subnets for NAT Gateway
     * - Private subnets with NAT Gateway for LLM service instances
     *
     * The private subnets allow outbound internet access through
     * the NAT Gateway for package updates and container image pulls
     *
     * IMPORTANT: ALB requires subnets in at least 2 different AZs
     */
    const vpc = new ec2.Vpc(this, "AiServicesVpc", {
      maxAzs: maxAzs, // Must be at least 2 for ALB
      natGateways: 1, // Single NAT gateway for cost optimization
      ipAddresses: ec2.IpAddresses.cidr(vpcCidr),
      subnetConfiguration: [
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: cidrMask,
        },
        {
          name: "private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: cidrMask,
        },
      ],
    });

    // Debug subnet information
    console.log(`VPC created with ID: ${vpc.vpcId}`);
    console.log(`Public subnets count: ${vpc.publicSubnets.length}`);
    console.log(`Private subnets count: ${vpc.privateSubnets.length}`);
    console.log(
      `Available AZs: ${cdk.Stack.of(this).availabilityZones.join(", ")}`
    );

    /**
     * Create S3 Gateway Endpoint
     *
     * This allows instances in private subnets to access S3 without
     * going through the NAT Gateway, reducing data transfer costs
     * and improving security by keeping traffic within AWS network
     */
    vpc.addGatewayEndpoint("S3Endpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
    });

    /**
     * Security Groups
     *
     * Define security groups with least privilege principle:
     * 1. LLM Service SG - For the EC2 instances running the LLM service
     * 2. ALB SG - For the private Application Load Balancer
     * 3. Lambda SG - For Lambda functions inside the VPC
     */

    // Security group for LLM service instances
    const llmServiceSg = new ec2.SecurityGroup(this, "LlmServiceSg", {
      vpc,
      description: "Security group for LLM Service instances",
      allowAllOutbound: true, // Allow outbound for container image pulls and updates
    });
    cdk.Tags.of(llmServiceSg).add("Name", "llm-service-sg");

    // Security group for the Application Load Balancer
    const albSg = new ec2.SecurityGroup(this, "AlbSg", {
      vpc,
      description: "Security group for Application Load Balancer",
      allowAllOutbound: false, // Restrict outbound traffic (least privilege)
    });
    cdk.Tags.of(albSg).add("Name", "alb-sg");

    // Security group for Lambda functions inside the VPC
    const lambdaSg = new ec2.SecurityGroup(this, "LambdaSg", {
      vpc,
      description: "Security group for Lambda functions inside the VPC",
      allowAllOutbound: true, // Allow outbound for Lambda functions
    });
    cdk.Tags.of(lambdaSg).add("Name", "lambda-sg");

    /**
     * Security Group Rules
     *
     * Define the necessary ingress/egress rules:
     * - Allow ALB to send traffic to LLM service
     * - Allow LLM service to receive traffic from ALB
     * - Allow Lambda to communicate with ALB
     */

    // Allow LLM service to receive traffic from ALB
    llmServiceSg.addIngressRule(
      albSg,
      ec2.Port.tcp(llmServicePort),
      "Allow ALB to connect to LLM service"
    );

    // Allow LLM service to receive traffic on port 443 for health checks
    llmServiceSg.addIngressRule(
      albSg,
      ec2.Port.tcp(443),
      "Allow ALB to connect to HTTPS health check proxy"
    );

    // Allow ALB to send traffic to LLM service
    albSg.addEgressRule(
      llmServiceSg,
      ec2.Port.tcp(llmServicePort),
      "Allow ALB to send traffic to LLM service"
    );

    // Allow ALB to send traffic to health check proxy
    albSg.addEgressRule(
      llmServiceSg,
      ec2.Port.tcp(443),
      "Allow ALB to send traffic to HTTPS health check proxy"
    );

    // Allow ALB to receive traffic from Lambda
    albSg.addIngressRule(
      lambdaSg,
      ec2.Port.tcp(443),
      "Allow Lambda to connect to ALB HTTPS"
    );

    // For gRPC over HTTP/2
    albSg.addIngressRule(
      lambdaSg,
      ec2.Port.tcp(443),
      "Allow Lambda to connect to ALB HTTPS"
    );

    // Allow Lambda to send traffic to ALB
    lambdaSg.addEgressRule(
      albSg,
      ec2.Port.tcp(443),
      "Allow Lambda to send traffic to ALB HTTPS"
    );

    // For gRPC over HTTP/2
    lambdaSg.addEgressRule(
      albSg,
      ec2.Port.tcp(443),
      "Allow Lambda to send traffic to ALB HTTPS"
    );

    /**
     * Application Load Balancer (ALB)
     *
     * Create a private ALB that will:
     * - Serve as the single entry point for all traffic to LLM services
     * - Handle health checks and only route to healthy instances
     * - Distribute traffic across multiple instances
     * - Provide a stable endpoint for Lambdas to communicate with
     *
     * IMPORTANT: ALB requires subnets in at least 2 different AZs
     */
    const alb = new elasticloadbalancingv2.ApplicationLoadBalancer(
      this,
      "LlmServiceAlb",
      {
        vpc,
        internetFacing: false, // Internal ALB, not exposed to internet
        securityGroup: albSg,
        vpcSubnets: {
          subnets: vpc.privateSubnets,
        },
      }
    );

    /**
     * Target Group for ALB
     *
     * Define how the ALB will route traffic to instances:
     * - Which port to use
     * - How to perform health checks
     * - What type of targets (EC2 instances)
     * - Configured for gRPC and WebSocket support
     */
    const targetGroup = new elasticloadbalancingv2.ApplicationTargetGroup(
      this,
      "LlmServiceTargetGroup",
      {
        vpc,
        port: llmServicePort,
        protocol: elasticloadbalancingv2.ApplicationProtocol.HTTPS,
        targetType: elasticloadbalancingv2.TargetType.INSTANCE,
        protocolVersion:
          elasticloadbalancingv2.ApplicationProtocolVersion.HTTP2,
        healthCheck: {
          path: "/health", // Health check endpoint on HTTP proxy
          port: "443", // Use the HTTPS health check proxy running on port 443
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(5),
        },
        // Increase deregistration delay to allow for longer gRPC streams to complete
        deregistrationDelay: cdk.Duration.seconds(120),
      }
    );

    // Configure target group for HTTP/2 support (required for gRPC) and sticky sessions
    const cfnTargetGroup = targetGroup.node
      .defaultChild as elasticloadbalancingv2.CfnTargetGroup;
    cfnTargetGroup.addPropertyOverride("TargetGroupAttributes", [
      {
        Key: "load_balancing.algorithm.type",
        Value: "least_outstanding_requests",
      },
      {
        Key: "deregistration_delay.timeout_seconds",
        Value: "120",
      },
      {
        Key: "stickiness.enabled",
        Value: "true",
      },
      {
        Key: "stickiness.type",
        Value: "app_cookie",
      },
      {
        Key: "stickiness.app_cookie.cookie_name",
        Value: "LlmServiceStickiness",
      },
      {
        Key: "stickiness.app_cookie.duration_seconds",
        Value: "900", // 15 minutes
      },
    ]);

    /**
     * ALB Listener
     *
     * Configure how the ALB accepts traffic:
     * - Listen on HTTPS port 443 (internal only)
     * - Use imported ACM certificate for TLS
     * - Route all traffic to the LLM service target group
     */
    const listener = alb.addListener("LlmServiceListener", {
      port: 443,
      protocol: elasticloadbalancingv2.ApplicationProtocol.HTTPS,
      defaultTargetGroups: [targetGroup],
      certificates: [certificate],
    });

    const privateHostedZone = new route53.PrivateHostedZone(
      this,
      "PrivateHostedZone",
      {
        zoneName: certificateDomain,
        vpc: vpc,
        comment: "Private hosted zone for deepseek LLM service",
      }
    );

    // Create A record pointing to the ALB
    new route53.ARecord(this, "AlbAliasRecord", {
      zone: privateHostedZone,
      recordName: certificateDomain,
      target: route53.RecordTarget.fromAlias(
        new route53aliases.LoadBalancerTarget(alb)
      ),
      comment: "Points to the internal ALB for deepseek LLM service",
    });

    /**
     * Store Important Values in SSM Parameter Store
     *
     * These parameters will be used by:
     * 1. The LLM Service Infrastructure Stack
     * 2. The WebSocket Lambda functions
     *
     * Using SSM eliminates the need for hardcoding values and
     * allows for better cross-stack references
     */

    // Store the hosted zone ID in SSM for cross-stack reference
    new ssm.StringParameter(this, "SsmHostedZoneId", {
      parameterName: `${serviceDiscoveryPrefix}/SharedAiServicesHostedZoneId`,
      stringValue: privateHostedZone.hostedZoneId,
      description: "ID of the private hosted zone for deepseek LLM service",
    });

    // Add output for the hosted zone
    new cdk.CfnOutput(this, "PrivateHostedZoneId", {
      value: privateHostedZone.hostedZoneId,
      description: "ID of the private hosted zone",
      exportName: "SharedAiServicesPrivateHostedZoneId",
    });

    // VPC and Network Configuration
    new ssm.StringParameter(this, "SsmVpcId", {
      parameterName: `${serviceDiscoveryPrefix}/SharedAiServicesVpcId`,
      stringValue: vpc.vpcId,
      description: "VPC ID for shared AI services",
    });

    // Store the maxAzs parameter to help LLM service stack know how many subnets to look for
    new ssm.StringParameter(this, "SsmMaxAzs", {
      parameterName: `${serviceDiscoveryPrefix}/SharedAiServicesMaxAzs`,
      stringValue: maxAzs.toString(),
      description: "Maximum number of Availability Zones used in VPC",
    });

    // Store private subnet parameters
    vpc.privateSubnets.forEach((subnet, index) => {
      new ssm.StringParameter(this, `SsmLlmSubnet${index + 1}Id`, {
        parameterName: `${serviceDiscoveryPrefix}/SharedAiServicesPrivateSubnet${
          index + 1
        }Id`,
        stringValue: subnet.subnetId,
        description: `Private subnet ${index + 1} ID for shared AI services`,
      });
    });

    // Security Groups
    new ssm.StringParameter(this, "SsmLlmServiceSgId", {
      parameterName: `${serviceDiscoveryPrefix}/SharedAiServicesLlmServiceSgId`,
      stringValue: llmServiceSg.securityGroupId,
      description: "Security Group ID for LLM Service instances",
    });

    new ssm.StringParameter(this, "SsmAlbSgId", {
      parameterName: `${serviceDiscoveryPrefix}/SharedAiServicesAlbSgId`,
      stringValue: albSg.securityGroupId,
      description: "Security Group ID for ALB",
    });

    new ssm.StringParameter(this, "SsmLambdaSgId", {
      parameterName: `${serviceDiscoveryPrefix}/SharedAiServicesLambdaSgId`,
      stringValue: lambdaSg.securityGroupId,
      description: "Security Group ID for Lambda functions",
    });

    // ALB Information
    new ssm.StringParameter(this, "SsmAlbDnsName", {
      parameterName: `${serviceDiscoveryPrefix}/SharedAiServicesAlbDnsName`,
      stringValue: alb.loadBalancerDnsName,
      description: "DNS Name of the Application Load Balancer",
    });

    new ssm.StringParameter(this, "SsmAlbListener", {
      parameterName: `${serviceDiscoveryPrefix}/SharedAiServicesAlbListener`,
      stringValue: listener.listenerArn,
      description: "ARN of the ALB Listener",
    });

    new ssm.StringParameter(this, "SsmCertificateArn", {
      parameterName: `${serviceDiscoveryPrefix}/SharedAiServicesCertificateArn`,
      stringValue: acmCertificateArn,
      description: "ARN of the ACM Certificate used by the ALB",
    });

    new ssm.StringParameter(this, "SsmCertificateDomain", {
      parameterName: `${serviceDiscoveryPrefix}/SharedAiServicesCertificateDomain`,
      stringValue: certificateDomain,
      description: "Domain name of the ACM Certificate used by the ALB",
    });

    new ssm.StringParameter(this, "SsmTargetGroupArn", {
      parameterName: `${serviceDiscoveryPrefix}/SharedAiServicesTargetGroupArn`,
      stringValue: targetGroup.targetGroupArn,
      description: "ARN of the ALB Target Group",
    });

    new ssm.StringParameter(this, "SsmVpcCidrBlock", {
      parameterName: `${serviceDiscoveryPrefix}/SharedAiServicesVpcCidrBlock`,
      stringValue: vpc.vpcCidrBlock,
      description: "CIDR block of the shared VPC",
    });

    // Parameters specifically for WebSocket Lambda - now direct ALB access
    new ssm.StringParameter(this, "SsmWsVpcId", {
      parameterName: `${webSocketLambdaPrefix}/SharedAiServicesVpcId`,
      stringValue: vpc.vpcId,
      description: "VPC ID for shared AI services",
    });

    new ssm.StringParameter(this, "SsmWsAlbDnsName", {
      parameterName: `${webSocketLambdaPrefix}/SharedAiServicesAlbDnsName`,
      stringValue: alb.loadBalancerDnsName,
      description: "DNS Name of the Application Load Balancer",
    });

    new ssm.StringParameter(this, "SsmWsLambdaSgId", {
      parameterName: `${webSocketLambdaPrefix}/SharedAiServicesLambdaSgId`,
      stringValue: lambdaSg.securityGroupId,
      description: "Security Group ID for Lambda functions",
    });

    // Store private subnet parameters for Lambda configuration
    vpc.privateSubnets.forEach((subnet, index) => {
      new ssm.StringParameter(this, `SsmWsSubnet${index + 1}Id`, {
        parameterName: `${webSocketLambdaPrefix}/SharedAiServicesPrivateSubnet${
          index + 1
        }Id`,
        stringValue: subnet.subnetId,
        description: `Private subnet ${index + 1} ID for WebSocket Lambda`,
      });
    });

    /**
     * Resource Tagging
     *
     * Add descriptive tags to key resources for easier identification
     * in the AWS Console and for cost attribution
     */
    cdk.Tags.of(vpc).add("Name", "ai-services-vpc");
    cdk.Tags.of(alb).add("Name", "llm-service-alb");
    cdk.Tags.of(targetGroup).add("Name", "llm-service-target-group");
    cdk.Tags.of(lambdaSg).add("Name", "lambda-sg");

    /**
     * Stack Outputs
     *
     * Export important resources for cross-stack references
     * and for visibility in the CloudFormation console
     */

    // VPC and Subnet Outputs
    new cdk.CfnOutput(this, "VpcId", {
      value: vpc.vpcId,
      description: "The ID of the VPC",
      exportName: "SharedAiServicesVpcId",
    });

    // Output private subnets
    vpc.privateSubnets.forEach((subnet, index) => {
      new cdk.CfnOutput(this, `PrivateSubnet${index + 1}Id`, {
        value: subnet.subnetId,
        description: `The ID of private subnet ${index + 1}`,
        exportName: `SharedAiServicesPrivateSubnet${index + 1}Id`,
      });
    });

    // Output public subnets
    vpc.publicSubnets.forEach((subnet, index) => {
      new cdk.CfnOutput(this, `PublicSubnet${index + 1}Id`, {
        value: subnet.subnetId,
        description: `The ID of public subnet ${index + 1}`,
        exportName: `SharedAiServicesPublicSubnet${index + 1}Id`,
      });
    });

    // Output MaxAzs
    new cdk.CfnOutput(this, "MaxAzs", {
      value: maxAzs.toString(),
      description: "Maximum number of Availability Zones used in VPC",
      exportName: "SharedAiServicesMaxAzs",
    });

    // Security Group Outputs
    new cdk.CfnOutput(this, "LlmServiceSecurityGroupId", {
      value: llmServiceSg.securityGroupId,
      description: "Security Group ID for LLM Service instances",
      exportName: "SharedAiServicesLlmServiceSgId",
    });

    new cdk.CfnOutput(this, "AlbSecurityGroupId", {
      value: albSg.securityGroupId,
      description: "Security Group ID for Application Load Balancer",
      exportName: "SharedAiServicesAlbSgId",
    });

    new cdk.CfnOutput(this, "LambdaSecurityGroupId", {
      value: lambdaSg.securityGroupId,
      description: "Security Group ID for Lambda functions",
      exportName: "SharedAiServicesLambdaSgId",
    });

    // ALB Outputs
    new cdk.CfnOutput(this, "AlbDnsName", {
      value: alb.loadBalancerDnsName,
      description: "DNS Name of the Application Load Balancer",
      exportName: "SharedAiServicesAlbDnsName",
    });

    new cdk.CfnOutput(this, "AlbArn", {
      value: alb.loadBalancerArn,
      description: "ARN of the Application Load Balancer",
      exportName: "SharedAiServicesAlbArn",
    });

    new cdk.CfnOutput(this, "TargetGroupArn", {
      value: targetGroup.targetGroupArn,
      description: "ARN of the ALB Target Group",
      exportName: "SharedAiServicesTargetGroupArn",
    });

    new cdk.CfnOutput(this, "CertificateArn", {
      value: acmCertificateArn,
      description: "ARN of the ACM Certificate used by the ALB",
      exportName: "SharedAiServicesCertificateArn",
    });

    new cdk.CfnOutput(this, "CertificateDomain", {
      value: certificateDomain,
      description: "Domain name of the ACM Certificate used by the ALB",
      exportName: "SharedAiServicesCertificateDomain",
    });

    // VPC CIDR
    new cdk.CfnOutput(this, "VpcCidrBlock", {
      value: vpc.vpcCidrBlock,
      description: "The CIDR block of the VPC",
      exportName: "SharedAiServicesVpcCidrBlock",
    });
  }
}