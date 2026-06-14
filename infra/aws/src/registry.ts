// ECR private repo for the single container image (the Dockerfile `server`
// target — Fastify API serving the built SPA on one origin). CI / a local
// `make deploy-dev` pushes here; the EC2 instance pulls via its instance profile
// (see iam.ts). A lifecycle policy expires old/untagged images so storage can't
// grow unbounded on a long-lived single-box deploy.
import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

const tags = { Project: 'cobblecompanion', ManagedBy: 'pulumi' };

export const repo = new aws.ecr.Repository('cobblecompanion', {
  name: 'cobblecompanion',
  imageTagMutability: 'MUTABLE',
  imageScanningConfiguration: { scanOnPush: true },
  forceDelete: true, // a Phase-0 personal repo: allow `pulumi destroy` to remove it with images
  tags,
});

new aws.ecr.LifecyclePolicy('cobblecompanion-lifecycle', {
  repository: repo.name,
  policy: JSON.stringify({
    rules: [
      {
        rulePriority: 1,
        description: 'Expire untagged images after 1 day',
        selection: {
          tagStatus: 'untagged',
          countType: 'sinceImagePushed',
          countUnit: 'days',
          countNumber: 1,
        },
        action: { type: 'expire' },
      },
      {
        rulePriority: 2,
        description: 'Keep only the 10 most recent tagged images',
        selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: 10 },
        action: { type: 'expire' },
      },
    ],
  }),
});

/** `<account>.dkr.ecr.<region>.amazonaws.com/cobblecompanion:<tag>`. */
export function imageUri(tag: pulumi.Input<string>): pulumi.Output<string> {
  return pulumi.interpolate`${repo.repositoryUrl}:${tag}`;
}

/** The registry host for `docker login` (`<account>.dkr.ecr.<region>.amazonaws.com`). */
export const registryHost: pulumi.Output<string> = repo.repositoryUrl.apply(
  (url) => url.split('/')[0],
);
