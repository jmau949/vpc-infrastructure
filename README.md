# VPC Infrastructure for AI Services

This repository contains AWS CDK infrastructure code that defines a shared VPC and related resources for AI/ML services, specifically the DeepSeek LLM service and WebSocket Lambda function.

## Overview

The infrastructure defined in this repository creates a secure and isolated VPC environment with:

- Private subnets with no internet access
- Necessary VPC endpoints for AWS services (S3, DynamoDB, ECR, etc.)
- Highly restrictive security groups following the principle of least privilege
- Cloud Map service discovery for microservice communication
- SSM Parameters for sharing infrastructure details with other services

## Architecture

![Architecture Diagram](docs/architecture.png)

The infrastructure follows a hub-and-spoke model:

1. This VPC infrastructure serves as the central "hub"
2. The DeepSeek LLM service and WebSocket Lambda applications are "spokes" that utilize the shared infrastructure

### Security Groups

Three main security groups are defined with strict rules:

1. **LLM Service Security Group**

   - Allows inbound gRPC traffic (port 50051) from Lambda functions
   - Allows outbound HTTPS (port 443) traffic to VPC endpoints only

2. **Lambda Client Security Group**

   - Allows outbound traffic to LLM service on port 50051
   - Allows outbound HTTPS to API Gateway and Service Discovery endpoints

3. **API Gateway Endpoint Security Group**
   - Allows inbound HTTPS (port 443) from Lambda functions

## Deployment

### Prerequisites

- AWS CLI configured with appropriate permissions
- Node.js (v14.x or later)
- AWS CDK CLI installed (`npm install -g aws-cdk`)

### Steps

1. Install dependencies:

   ```bash
   npm install
   ```

2. Bootstrap CDK (if not already done):

   ```bash
   npx cdk bootstrap
   ```

3. Deploy the stack:
   ```bash
   npx cdk deploy
   ```

## Integration with Other Services

This infrastructure automatically populates SSM Parameter Store with its outputs, enabling other services to reference these resources without hard dependencies.

### For the DeepSeek LLM Service

The LLM service reads SSM parameters using this pattern:

```typescript
const vpcId = ssm.StringParameter.valueForStringParameter(
  this,
  "/deepseek-llm-service/SharedAiServicesVpcId"
);
```

### For the WebSocket Lambda Service

The WebSocket Lambda service reads parameters using CloudFormation's SSM resolution:

```
VpcId: "{{resolve:ssm:/websocket-lambda-deepseek/SharedAiServicesVpcId}}"
```

## SSM Parameters

The following SSM parameters are automatically created during deployment:

### For DeepSeek LLM Service:

- `/deepseek-llm-service/SharedAiServicesVpcId`
- `/deepseek-llm-service/SharedAiServicesPrivateSubnet1Id`
- `/deepseek-llm-service/SharedAiServicesPrivateSubnet2Id`
- `/deepseek-llm-service/SharedAiServicesLlmServiceSgId`
- `/deepseek-llm-service/SharedAiServicesLambdaClientSgId`
- `/deepseek-llm-service/SharedAiServicesApiGatewayEndpointSgId`
- `/deepseek-llm-service/SharedAiServicesNamespaceId`
- `/deepseek-llm-service/SharedAiServicesNamespaceName`
- `/deepseek-llm-service/SharedAiServicesLlmServiceId`
- `/deepseek-llm-service/SharedAiServicesLlmServiceName`
- `/deepseek-llm-service/SharedAiServicesVpcCidrBlock`

### For WebSocket Lambda Service:

- `/websocket-lambda-deepseek/SharedAiServicesVpcId`
- `/websocket-lambda-deepseek/SharedAiServicesPrivateSubnet1Id`
- `/websocket-lambda-deepseek/SharedAiServicesPrivateSubnet2Id`
- `/websocket-lambda-deepseek/SharedAiServicesLambdaClientSgId`
- `/websocket-lambda-deepseek/SharedAiServicesNamespaceName`
- `/websocket-lambda-deepseek/SharedAiServicesLlmServiceName`

## CloudFormation Exports

For backward compatibility, the stack also exports values via CloudFormation exports:

- `SharedAiServicesVpcId`
- `SharedAiServicesPrivateSubnet1Id`, `SharedAiServicesPrivateSubnet2Id`
- `SharedAiServicesLlmServiceSgId`
- `SharedAiServicesLambdaClientSgId`
- `SharedAiServicesApiGatewayEndpointSgId`
- `SharedAiServicesNamespaceId`, `SharedAiServicesNamespaceName`
- `SharedAiServicesLlmServiceId`, `SharedAiServicesLlmServiceName`
- `SharedAiServicesVpcCidrBlock`

## Cleanup

To remove all resources created by this stack:

```bash
cdk destroy
```

**Important**: Before destroying this stack, ensure that no other stacks or resources depend on it.

## Security Considerations

- The VPC is completely isolated from the internet
- Security groups follow the principle of least privilege
- All communication happens over private VPC endpoints
- No public subnets are defined

## Development

To make changes to this infrastructure:

1. Modify the code in `lib/vpc-infrastructure-stack.ts`
2. Run `cdk diff` to see what would change
3. Run `cdk deploy` to apply the changes

## License

MIT
