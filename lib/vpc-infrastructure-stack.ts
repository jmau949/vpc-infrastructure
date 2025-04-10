import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import { Construct } from "constructs";

export class VpcInfrastructureStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create a VPC with isolated subnets (no internet access)
    const vpc = new ec2.Vpc(this, "AiServicesVpc", {
      maxAzs: 2,
      natGateways: 0, // No NAT gateways to save costs
      ipAddresses: ec2.IpAddresses.cidr("172.16.0.0/16"),
      subnetConfiguration: [
        {
          name: "private",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // Create essential VPC endpoints for AWS services

    // S3 Gateway Endpoint
    const s3Endpoint = vpc.addGatewayEndpoint("S3Endpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // DynamoDB Gateway Endpoint
    const dynamoDbEndpoint = vpc.addGatewayEndpoint("DynamoDBEndpoint", {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // ECR Endpoints
    const ecrEndpoint = vpc.addInterfaceEndpoint("EcrEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
    });

    const ecrDockerEndpoint = vpc.addInterfaceEndpoint("EcrDockerEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
    });

    // Service Discovery Endpoint
    const serviceDiscoveryEndpoint = new ec2.InterfaceVpcEndpoint(
      this,
      "ServiceDiscoveryEndpoint",
      {
        vpc,
        service: new ec2.InterfaceVpcEndpointService(
          `com.amazonaws.${this.region}.servicediscovery`
        ),
        privateDnsEnabled: true,
      }
    );

    // API Gateway Endpoint for WebSocket API
    const apiGatewayEndpoint = new ec2.InterfaceVpcEndpoint(
      this,
      "ApiGatewayEndpoint",
      {
        vpc,
        service: new ec2.InterfaceVpcEndpointService(
          `com.amazonaws.${this.region}.execute-api`
        ),
        privateDnsEnabled: true,
      }
    );

    // Security Groups for Microservices

    // 1. LLM Service Security Group
    const llmServiceSg = new ec2.SecurityGroup(this, "LlmServiceSg", {
      vpc,
      description: "Security group for LLM Service instances",
      allowAllOutbound: false, // Restrict outbound traffic
    });

    // 2. Lambda Client Security Group
    const lambdaClientSg = new ec2.SecurityGroup(this, "LambdaClientSg", {
      vpc,
      description:
        "Security group for Lambda functions connecting to LLM Service",
      allowAllOutbound: false, // Restrict outbound traffic
    });

    // 3. API Gateway Endpoint Security Group
    const apiGatewayEndpointSg = new ec2.SecurityGroup(
      this,
      "ApiGatewayEndpointSg",
      {
        vpc,
        description: "Security group for API Gateway Management endpoint",
        allowAllOutbound: false, // Restrict outbound traffic
      }
    );

    // Security Group Rules

    // LLM Service Rules
    llmServiceSg.addIngressRule(
      lambdaClientSg,
      ec2.Port.tcp(50051),
      "Allow Lambda clients to connect to LLM service"
    );

    // Allow LLM Service to pull images from ECR
    llmServiceSg.addEgressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      "Allow HTTPS egress to VPC endpoints"
    );

    // Lambda Client Rules
    lambdaClientSg.addEgressRule(
      llmServiceSg,
      ec2.Port.tcp(50051),
      "Allow Lambda to connect to LLM service"
    );

    lambdaClientSg.addEgressRule(
      ec2.Peer.securityGroupId(apiGatewayEndpointSg.securityGroupId),
      ec2.Port.tcp(443),
      "Allow Lambda to connect to API Gateway endpoint"
    );

    // Allow Lambda to use service discovery
    lambdaClientSg.addEgressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      "Allow HTTPS egress to VPC endpoints for Service Discovery"
    );

    // API Gateway Endpoint Rules
    apiGatewayEndpointSg.addIngressRule(
      lambdaClientSg,
      ec2.Port.tcp(443),
      "Allow Lambda to communicate with API Gateway"
    );

    // Apply the security group to the API Gateway endpoint
    apiGatewayEndpoint.addToPolicy(
      new cdk.aws_iam.PolicyStatement({
        effect: cdk.aws_iam.Effect.ALLOW,
        principals: [new cdk.aws_iam.AnyPrincipal()],
        actions: ["execute-api:Invoke"],
        resources: ["*"],
      })
    );

    // Create Cloud Map namespace for service discovery
    const namespace = new servicediscovery.PrivateDnsNamespace(
      this,
      "AiServicesNamespace",
      {
        name: "ai-services.local",
        vpc,
        description: "Namespace for AI Language Model Services",
      }
    );

    // Create a service discovery service for the LLM service
    const llmService = namespace.createService("DeepseekLlmService", {
      name: "deepseek-llm",
      dnsRecordType: servicediscovery.DnsRecordType.A,
      dnsTtl: cdk.Duration.seconds(10),
      description: "DeepSeek LLM service for inference",
    });

    // Outputs
    // VPC and Subnet IDs
    new cdk.CfnOutput(this, "VpcId", {
      value: vpc.vpcId,
      description: "The ID of the VPC",
      exportName: "AiServicesVpcId",
    });

    vpc.privateSubnets.forEach((subnet, index) => {
      new cdk.CfnOutput(this, `PrivateSubnet${index + 1}Id`, {
        value: subnet.subnetId,
        description: `The ID of private subnet ${index + 1}`,
        exportName: `AiServicesPrivateSubnet${index + 1}Id`,
      });
    });

    // Security Group IDs
    new cdk.CfnOutput(this, "LlmServiceSecurityGroupId", {
      value: llmServiceSg.securityGroupId,
      description: "Security Group ID for LLM Service instances",
      exportName: "AiServicesLlmServiceSgId",
    });

    new cdk.CfnOutput(this, "LambdaClientSecurityGroupId", {
      value: lambdaClientSg.securityGroupId,
      description:
        "Security Group ID for Lambda functions connecting to LLM Service",
      exportName: "AiServicesLambdaClientSgId",
    });

    new cdk.CfnOutput(this, "ApiGatewayEndpointSecurityGroupId", {
      value: apiGatewayEndpointSg.securityGroupId,
      description: "Security Group ID for API Gateway Management endpoint",
      exportName: "AiServicesApiGatewayEndpointSgId",
    });

    // Cloud Map Namespace and Service
    new cdk.CfnOutput(this, "CloudMapNamespaceId", {
      value: namespace.namespaceId,
      description: "The ID of the Cloud Map namespace",
      exportName: "AiServicesNamespaceId",
    });

    new cdk.CfnOutput(this, "CloudMapNamespaceName", {
      value: namespace.namespaceName,
      description: "The name of the Cloud Map namespace",
      exportName: "AiServicesNamespaceName",
    });

    new cdk.CfnOutput(this, "LlmServiceId", {
      value: llmService.serviceId,
      description: "The ID of the LLM Service in Cloud Map",
      exportName: "AiServicesLlmServiceId",
    });

    new cdk.CfnOutput(this, "LlmServiceName", {
      value: llmService.serviceName,
      description: "The name of the LLM Service in Cloud Map",
      exportName: "AiServicesLlmServiceName",
    });

    // VPC CIDR
    new cdk.CfnOutput(this, "VpcCidrBlock", {
      value: vpc.vpcCidrBlock,
      description: "The CIDR block of the VPC",
      exportName: "AiServicesVpcCidrBlock",
    });
  }
}
