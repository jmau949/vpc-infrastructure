# Architecture Diagram

This document would normally contain the architecture diagram image and detailed explanation of how the VPC infrastructure works.

## Components

1. **Isolated VPC** - Private subnets with no internet access
2. **VPC Endpoints** - For AWS services (S3, DynamoDB, ECR, API Gateway)
3. **Security Groups** - Restrictive, least-privilege access controls
4. **Cloud Map Service Discovery** - For service communication
5. **SSM Parameters** - For sharing infrastructure details

## Integration Points

- **DeepSeek LLM Service** - Runs in the VPC with security group restrictions
- **WebSocket Lambda** - Connects to LLM Service via private networking

## Data Flow

1. Client -> API Gateway -> WebSocket Lambda
2. WebSocket Lambda -> Service Discovery -> LLM Service
3. LLM Service -> Response -> WebSocket Lambda -> Client

## Security Boundaries

All components run in isolated subnets with strict security group rules limiting communication paths.

---

_Note: Replace this document with an actual architecture diagram image and detailed explanation._
