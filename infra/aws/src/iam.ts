// Runtime IAM for the EC2 instance. It runs as its own role with the narrowest
// viable access: pull the image from ECR, read its two secrets, and be managed
// via SSM Session Manager (so no SSH key and no open port 22).
import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import { repo } from './registry';
import { parameterArns } from './secrets';

const tags = { Project: 'cobblecompanion', ManagedBy: 'pulumi' };
const region = new pulumi.Config('aws').require('region');

export const instanceRole = new aws.iam.Role('cc-ec2-role', {
  assumeRolePolicy: JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Service: 'ec2.amazonaws.com' },
        Action: 'sts:AssumeRole',
      },
    ],
  }),
  tags,
});

// SSM Session Manager (shell access without SSH/port 22) + SSM agent baseline.
new aws.iam.RolePolicyAttachment('cc-ssm', {
  role: instanceRole.name,
  policyArn: 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
});

// ECR pull. GetAuthorizationToken has no resource scope (must be `*`); the layer
// pulls are scoped to this one repository.
new aws.iam.RolePolicy('cc-ecr-pull', {
  role: instanceRole.id,
  policy: repo.arn.apply((repoArn) =>
    JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: ['ecr:GetAuthorizationToken'], Resource: '*' },
        {
          Effect: 'Allow',
          Action: [
            'ecr:BatchGetImage',
            'ecr:GetDownloadUrlForLayer',
            'ecr:BatchCheckLayerAvailability',
          ],
          Resource: repoArn,
        },
      ],
    }),
  ),
});

// Read exactly the two SSM SecureString parameters (no wildcard), plus decrypt
// via the default SSM KMS key — scoped to SSM use only with the ViaService
// condition, so this can't decrypt anything else.
new aws.iam.RolePolicy('cc-secrets-read', {
  role: instanceRole.id,
  policy: pulumi.all(parameterArns).apply((arns) =>
    JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: ['ssm:GetParameter', 'ssm:GetParameters'], Resource: arns },
        {
          Effect: 'Allow',
          Action: ['kms:Decrypt'],
          Resource: '*',
          Condition: { StringEquals: { 'kms:ViaService': `ssm.${region}.amazonaws.com` } },
        },
      ],
    }),
  ),
});

export const instanceProfile = new aws.iam.InstanceProfile('cc-ec2-profile', {
  role: instanceRole.name,
  tags,
});
