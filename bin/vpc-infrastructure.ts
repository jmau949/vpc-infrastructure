#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { VpcInfrastructureStack } from "../lib/vpc-infrastructure-stack";

const app = new cdk.App();
new VpcInfrastructureStack(app, "AiServicesVpcStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || "us-west-2",
  },
  description:
    "Shared VPC infrastructure for AI services with least permissive security groups and SSM parameter integration",
});

app.synth();
