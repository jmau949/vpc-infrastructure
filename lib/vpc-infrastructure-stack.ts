import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as elasticloadbalancingv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import { Construct } from "constructs";

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
  /** Maximum number of Availability Zones to use (default: 1) */
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
    const maxAzs = props?.maxAzs || 1;
    const cidrMask = props?.cidrMask || 24;
    const llmServicePort = props?.llmServicePort || 50051;
    const serviceDiscoveryPrefix =
      props?.serviceDiscoveryPrefix || "/deepseek-llm-service";
    const webSocketLambdaPrefix =
      props?.webSocketLambdaPrefix || "/websocket-lambda-deepseek";

    /**
     * Create a VPC with both public and private subnets
     * - Public subnets for NAT Gateway
     * - Private subnets with NAT Gateway for LLM service instances
     *
     * The private subnets allow outbound internet access through
     * the NAT Gateway for package updates and container image pulls
     */
    const vpc = new ec2.Vpc(this, "AiServicesVpc", {
      maxAzs: maxAzs,
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

    /**
     * Security Group Rules
     *
     * Define the necessary ingress/egress rules:
     * - Allow ALB to send traffic to LLM service
     * - Allow LLM service to receive traffic from ALB
     */

    // Allow LLM service to receive traffic from ALB
    llmServiceSg.addIngressRule(
      albSg,
      ec2.Port.tcp(llmServicePort),
      "Allow ALB to connect to LLM service"
    );

    // Allow ALB to send traffic to LLM service
    albSg.addEgressRule(
      llmServiceSg,
      ec2.Port.tcp(llmServicePort),
      "Allow ALB to send traffic to LLM service"
    );

    /**
     * Application Load Balancer (ALB)
     *
     * Create a private ALB that will:
     * - Serve as the single entry point for all traffic to LLM services
     * - Handle health checks and only route to healthy instances
     * - Distribute traffic across multiple instances
     * - Provide a stable endpoint for Lambdas to communicate with
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
     */
    const targetGroup = new elasticloadbalancingv2.ApplicationTargetGroup(
      this,
      "LlmServiceTargetGroup",
      {
        vpc,
        port: llmServicePort,
        protocol: elasticloadbalancingv2.ApplicationProtocol.HTTP,
        targetType: elasticloadbalancingv2.TargetType.INSTANCE,
        healthCheck: {
          path: "/health", // Health check endpoint on LLM service
          port: llmServicePort.toString(),
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(5),
        },
      }
    );

    /**
     * ALB Listener
     *
     * Configure how the ALB accepts traffic:
     * - Listen on HTTP port 80 (internal only)
     * - Route all traffic to the LLM service target group
     */
    const listener = alb.addListener("LlmServiceListener", {
      port: 80,
      protocol: elasticloadbalancingv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [targetGroup],
    });

    /**
     * VPC Link for API Gateway
     *
     * Create a VPC Link that allows API Gateway to communicate with
     * resources inside the private VPC (specifically the ALB)
     *
     * This enables the WebSocket API to communicate with the ALB
     */
    const vpcLink = new apigatewayv2.CfnVpcLink(this, "ApiGatewayVpcLink", {
      name: "llm-service-vpc-link",
      subnetIds: vpc.privateSubnets.map((subnet) => subnet.subnetId),
      securityGroupIds: [albSg.securityGroupId],
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

    // VPC and Network Configuration
    new ssm.StringParameter(this, "SsmVpcId", {
      parameterName: `${serviceDiscoveryPrefix}/SharedAiServicesVpcId`,
      stringValue: vpc.vpcId,
      description: "VPC ID for shared AI services",
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

    new ssm.StringParameter(this, "SsmTargetGroupArn", {
      parameterName: `${serviceDiscoveryPrefix}/SharedAiServicesTargetGroupArn`,
      stringValue: targetGroup.targetGroupArn,
      description: "ARN of the ALB Target Group",
    });

    // VPC Link
    new ssm.StringParameter(this, "SsmVpcLinkId", {
      parameterName: `${serviceDiscoveryPrefix}/SharedAiServicesVpcLinkId`,
      stringValue: vpcLink.ref,
      description: "ID of the VPC Link for API Gateway v2",
    });

    new ssm.StringParameter(this, "SsmVpcCidrBlock", {
      parameterName: `${serviceDiscoveryPrefix}/SharedAiServicesVpcCidrBlock`,
      stringValue: vpc.vpcCidrBlock,
      description: "CIDR block of the shared VPC",
    });

    // Parameters specifically for WebSocket Lambda
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

    new ssm.StringParameter(this, "SsmWsVpcLinkId", {
      parameterName: `${webSocketLambdaPrefix}/SharedAiServicesVpcLinkId`,
      stringValue: vpcLink.ref,
      description: "ID of the VPC Link for API Gateway v2",
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

    new cdk.CfnOutput(this, "VpcLinkId", {
      value: vpcLink.ref,
      description: "ID of the VPC Link for API Gateway v2",
      exportName: "SharedAiServicesVpcLinkId",
    });

    new cdk.CfnOutput(this, "TargetGroupArn", {
      value: targetGroup.targetGroupArn,
      description: "ARN of the ALB Target Group",
      exportName: "SharedAiServicesTargetGroupArn",
    });

    // VPC CIDR
    new cdk.CfnOutput(this, "VpcCidrBlock", {
      value: vpc.vpcCidrBlock,
      description: "The CIDR block of the VPC",
      exportName: "SharedAiServicesVpcCidrBlock",
    });
  }
}