import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

// Define custom stack properties
export interface VpcInfrastructureStackProps {
  environmentName?: string;
  vpcCidr?: string;
  maxAzs?: number;
  cidrMask?: number;
  llmServicePort?: number;
  namespaceName?: string;
  llmServiceName?: string;
  serviceDiscoveryPrefix?: string;
  webSocketLambdaPrefix?: string;
  [key: string]: any; // Allow any other properties to be passed through
}

export class VpcInfrastructureStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props?: VpcInfrastructureStackProps
  ) {
    // Pass properties to the parent constructor
    super(scope, id, props);

    // Use provided values or defaults
    const vpcCidr = props?.vpcCidr || "172.16.0.0/16";
    const maxAzs = props?.maxAzs || 1;
    const cidrMask = props?.cidrMask || 24;
    const llmServicePort = props?.llmServicePort || 50051;
    const namespaceName = props?.namespaceName || "shared-ai-services.local";
    const llmServiceName = props?.llmServiceName || "deepseek-llm";
    const serviceDiscoveryPrefix =
      props?.serviceDiscoveryPrefix || "/deepseek-llm-service";
    const webSocketLambdaPrefix =
      props?.webSocketLambdaPrefix || "/websocket-lambda-deepseek";

    // Create a VPC with isolated subnets (no internet access)
    const vpc = new ec2.Vpc(this, "AiServicesVpc", {
      maxAzs: maxAzs,
      natGateways: 0, // No NAT gateways to save costs
      ipAddresses: ec2.IpAddresses.cidr(vpcCidr),
      subnetConfiguration: [
        {
          name: "isolated",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: cidrMask,
        },
      ],
    });

    // Debug subnet information
    console.log(`VPC created with ID: ${vpc.vpcId}`);
    console.log(`Private subnets count: ${vpc.privateSubnets.length}`);
    if (vpc.privateSubnets.length > 0) {
      console.log(`First private subnet ID: ${vpc.privateSubnets[0].subnetId}`);
    } else {
      console.log("No private subnets were created!");
    }

    // Create essential VPC endpoints for AWS services

    // S3 Gateway Endpoint
    vpc.addGatewayEndpoint("S3Endpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // DynamoDB Gateway Endpoint
    vpc.addGatewayEndpoint("DynamoDBEndpoint", {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // ECR Endpoints
    vpc.addInterfaceEndpoint("EcrEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
    });

    vpc.addInterfaceEndpoint("EcrDockerEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
    });

    // Service Discovery Endpoint
    new ec2.InterfaceVpcEndpoint(this, "ServiceDiscoveryEndpoint", {
      vpc,
      service: new ec2.InterfaceVpcEndpointService(
        `com.amazonaws.${cdk.Stack.of(this).region}.servicediscovery`
      ),
      privateDnsEnabled: true,
    });

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

    // API Gateway Endpoint for WebSocket API
    const apiGatewayEndpoint = new ec2.InterfaceVpcEndpoint(
      this,
      "ApiGatewayEndpoint",
      {
        vpc,
        service: new ec2.InterfaceVpcEndpointService(
          `com.amazonaws.${cdk.Stack.of(this).region}.execute-api`
        ),
        privateDnsEnabled: true,
        securityGroups: [apiGatewayEndpointSg], // Explicitly assign the security group
      }
    );

    // Security Group Rules

    // LLM Service Rules
    llmServiceSg.addIngressRule(
      lambdaClientSg,
      ec2.Port.tcp(llmServicePort),
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
      ec2.Port.tcp(llmServicePort),
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
        name: namespaceName,
        vpc,
        description: "Namespace for AI Language Model Services",
      }
    );

    // Create a service discovery service for the LLM service
    const llmService = namespace.createService("DeepseekLlmService", {
      name: llmServiceName,
      dnsRecordType: servicediscovery.DnsRecordType.A,
      dnsTtl: cdk.Duration.seconds(10),
      description: "DeepSeek LLM service for inference",
    });

    // ------------------------------------------------------------------------
    // Store infrastructure values in SSM Parameter Store for other services to use
    // ------------------------------------------------------------------------

    // VPC and Network Configuration
    new ssm.StringParameter(this, "SsmVpcId", {
      parameterName: `${serviceDiscoveryPrefix}/SharedAiServicesVpcId`,
      stringValue: vpc.vpcId,
      description: "VPC ID for shared AI services",
    });

    // Create the subnet parameters directly from the VPC's isolated subnets instead
    // This ensures we reference the correct type of subnets that are being created
    if (vpc.isolatedSubnets.length > 0) {
      console.log(
        `Using isolated subnets. First subnet ID: ${vpc.isolatedSubnets[0].subnetId}`
      );

      // Create parameter for the first subnet
      new ssm.StringParameter(this, "SsmLlmSubnet1Id", {
        parameterName: `${serviceDiscoveryPrefix}/SharedAiServicesPrivateSubnet1Id`,
        stringValue: vpc.isolatedSubnets[0].subnetId,
        description: "Private subnet 1 ID for shared AI services",
      });

      // For any additional subnets
      for (let i = 1; i < vpc.isolatedSubnets.length; i++) {
        new ssm.StringParameter(this, `SsmLlmSubnet${i + 1}Id`, {
          parameterName: `${serviceDiscoveryPrefix}/SharedAiServicesPrivateSubnet${
            i + 1
          }Id`,
          stringValue: vpc.isolatedSubnets[i].subnetId,
          description: `Private subnet ${i + 1} ID for shared AI services`,
        });
      }
    } else {
      console.log("No isolated subnets were created!");
    }

    // Keep the original private subnet code as fallback
    if (vpc.privateSubnets.length > 0) {
      console.log(`Using private subnets as fallback`);
      // Original code for private subnets (now as fallback)
    }

    new ssm.StringParameter(this, "SsmLlmServiceSgId", {
      parameterName: `${serviceDiscoveryPrefix}/SharedAiServicesLlmServiceSgId`,
      stringValue: llmServiceSg.securityGroupId,
      description: "Security Group ID for LLM Service instances",
    });

    new ssm.StringParameter(this, "SsmLambdaClientSgId", {
      parameterName: `${serviceDiscoveryPrefix}/SharedAiServicesLambdaClientSgId`,
      stringValue: lambdaClientSg.securityGroupId,
      description:
        "Security Group ID for Lambda functions connecting to LLM Service",
    });

    new ssm.StringParameter(this, "SsmApiGatewayEndpointSgId", {
      parameterName: `${serviceDiscoveryPrefix}/SharedAiServicesApiGatewayEndpointSgId`,
      stringValue: apiGatewayEndpointSg.securityGroupId,
      description: "Security Group ID for API Gateway endpoint",
    });

    // Service Discovery Configuration
    new ssm.StringParameter(this, "SsmNamespaceId", {
      parameterName: `${serviceDiscoveryPrefix}/SharedAiServicesNamespaceId`,
      stringValue: namespace.namespaceId,
      description: "Cloud Map namespace ID for AI services",
    });

    new ssm.StringParameter(this, "SsmNamespaceName", {
      parameterName: `${serviceDiscoveryPrefix}/SharedAiServicesNamespaceName`,
      stringValue: namespace.namespaceName,
      description: "Cloud Map namespace name for AI services",
    });

    new ssm.StringParameter(this, "SsmLlmServiceId", {
      parameterName: `${serviceDiscoveryPrefix}/SharedAiServicesLlmServiceId`,
      stringValue: llmService.serviceId,
      description: "LLM Service ID in Cloud Map",
    });

    new ssm.StringParameter(this, "SsmLlmServiceName", {
      parameterName: `${serviceDiscoveryPrefix}/SharedAiServicesLlmServiceName`,
      stringValue: llmService.serviceName,
      description: "LLM Service name in Cloud Map",
    });

    new ssm.StringParameter(this, "SsmVpcCidrBlock", {
      parameterName: `${serviceDiscoveryPrefix}/SharedAiServicesVpcCidrBlock`,
      stringValue: vpc.vpcCidrBlock,
      description: "CIDR block of the shared VPC",
    });

    // Also create parameters for websocket-lambda-deepseek
    new ssm.StringParameter(this, "SsmWsVpcId", {
      parameterName: `${webSocketLambdaPrefix}/SharedAiServicesVpcId`,
      stringValue: vpc.vpcId,
      description: "VPC ID for shared AI services",
    });

    // Store websocket lambda subnet parameters using isolated subnets
    if (vpc.isolatedSubnets.length > 0) {
      // Create parameter for the first subnet
      new ssm.StringParameter(this, "SsmWsSubnet1Id", {
        parameterName: `${webSocketLambdaPrefix}/SharedAiServicesPrivateSubnet1Id`,
        stringValue: vpc.isolatedSubnets[0].subnetId,
        description: "Private subnet 1 ID for shared AI services",
      });

      // For any additional subnets
      for (let i = 1; i < vpc.isolatedSubnets.length; i++) {
        new ssm.StringParameter(this, `SsmWsSubnet${i + 1}Id`, {
          parameterName: `${webSocketLambdaPrefix}/SharedAiServicesPrivateSubnet${
            i + 1
          }Id`,
          stringValue: vpc.isolatedSubnets[i].subnetId,
          description: `Private subnet ${i + 1} ID for shared AI services`,
        });
      }
    } else if (vpc.privateSubnets.length > 0) {
      // Fallback to private subnets if no isolated subnets
      new ssm.StringParameter(this, "SsmWsSubnet1Id", {
        parameterName: `${webSocketLambdaPrefix}/SharedAiServicesPrivateSubnet1Id`,
        stringValue: vpc.privateSubnets[0].subnetId,
        description: "Private subnet 1 ID for shared AI services",
      });

      // For any additional subnets
      for (let i = 1; i < vpc.privateSubnets.length; i++) {
        new ssm.StringParameter(this, `SsmWsSubnet${i + 1}Id`, {
          parameterName: `${webSocketLambdaPrefix}/SharedAiServicesPrivateSubnet${
            i + 1
          }Id`,
          stringValue: vpc.privateSubnets[i].subnetId,
          description: `Private subnet ${i + 1} ID for shared AI services`,
        });
      }
    }

    new ssm.StringParameter(this, "SsmWsLambdaClientSgId", {
      parameterName: `${webSocketLambdaPrefix}/SharedAiServicesLambdaClientSgId`,
      stringValue: lambdaClientSg.securityGroupId,
      description:
        "Security Group ID for Lambda functions connecting to LLM Service",
    });

    new ssm.StringParameter(this, "SsmWsNamespaceName", {
      parameterName: `${webSocketLambdaPrefix}/SharedAiServicesNamespaceName`,
      stringValue: namespace.namespaceName,
      description: "Cloud Map namespace name for AI services",
    });

    new ssm.StringParameter(this, "SsmWsLlmServiceName", {
      parameterName: `${webSocketLambdaPrefix}/SharedAiServicesLlmServiceName`,
      stringValue: llmService.serviceName,
      description: "LLM Service name in Cloud Map",
    });

    // Add API Gateway Endpoint Security Group ID for websocket-lambda-deepseek
    new ssm.StringParameter(this, "SsmWsApiGatewayEndpointSgId", {
      parameterName: `${webSocketLambdaPrefix}/SharedAiServicesApiGatewayEndpointSgId`,
      stringValue: apiGatewayEndpointSg.securityGroupId,
      description: "Security Group ID for API Gateway endpoint",
    });

    // Outputs
    // VPC and Subnet IDs
    new cdk.CfnOutput(this, "VpcId", {
      value: vpc.vpcId,
      description: "The ID of the VPC",
      exportName: "SharedAiServicesVpcId",
    });

    // Output both isolated and private subnets
    if (vpc.isolatedSubnets.length > 0) {
      vpc.isolatedSubnets.forEach((subnet, index: number) => {
        new cdk.CfnOutput(this, `IsolatedSubnet${index + 1}Id`, {
          value: subnet.subnetId,
          description: `The ID of isolated subnet ${index + 1}`,
          exportName: `SharedAiServicesPrivateSubnet${index + 1}Id`,
        });
      });
    } else if (vpc.privateSubnets.length > 0) {
      vpc.privateSubnets.forEach((subnet, index: number) => {
        new cdk.CfnOutput(this, `PrivateSubnet${index + 1}Id`, {
          value: subnet.subnetId,
          description: `The ID of private subnet ${index + 1}`,
          exportName: `SharedAiServicesPrivateSubnet${index + 1}Id`,
        });
      });
    }

    // Security Group IDs
    new cdk.CfnOutput(this, "LlmServiceSecurityGroupId", {
      value: llmServiceSg.securityGroupId,
      description: "Security Group ID for LLM Service instances",
      exportName: "SharedAiServicesLlmServiceSgId",
    });

    new cdk.CfnOutput(this, "LambdaClientSecurityGroupId", {
      value: lambdaClientSg.securityGroupId,
      description:
        "Security Group ID for Lambda functions connecting to LLM Service",
      exportName: "SharedAiServicesLambdaClientSgId",
    });

    new cdk.CfnOutput(this, "ApiGatewayEndpointSecurityGroupId", {
      value: apiGatewayEndpointSg.securityGroupId,
      description: "Security Group ID for API Gateway Management endpoint",
      exportName: "SharedAiServicesApiGatewayEndpointSgId",
    });

    // Cloud Map Namespace and Service
    new cdk.CfnOutput(this, "CloudMapNamespaceId", {
      value: namespace.namespaceId,
      description: "The ID of the Cloud Map namespace",
      exportName: "SharedAiServicesNamespaceId",
    });

    new cdk.CfnOutput(this, "CloudMapNamespaceName", {
      value: namespace.namespaceName,
      description: "The name of the Cloud Map namespace",
      exportName: "SharedAiServicesNamespaceName",
    });

    new cdk.CfnOutput(this, "LlmServiceId", {
      value: llmService.serviceId,
      description: "The ID of the LLM Service in Cloud Map",
      exportName: "SharedAiServicesLlmServiceId",
    });

    new cdk.CfnOutput(this, "LlmServiceName", {
      value: llmService.serviceName,
      description: "The name of the LLM Service in Cloud Map",
      exportName: "SharedAiServicesLlmServiceName",
    });

    // VPC CIDR
    new cdk.CfnOutput(this, "VpcCidrBlock", {
      value: vpc.vpcCidrBlock,
      description: "The CIDR block of the VPC",
      exportName: "SharedAiServicesVpcCidrBlock",
    });
  }
}
