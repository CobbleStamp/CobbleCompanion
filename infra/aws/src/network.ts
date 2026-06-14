// Network: just enough to host one public EC2 instance. Postgres is on Supabase
// (external), so there is NO in-VPC database — hence no private subnets, no DB
// subnet group, and no DB security group. The instance reaches Supabase, ECR,
// OpenRouter, and Let's Encrypt over the public internet through the Internet
// Gateway, so there is also no NAT gateway (it would add ~$32/mo for nothing).
import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

const tags = { Project: 'cobblecompanion', ManagedBy: 'pulumi' };

export const vpc = new aws.ec2.Vpc('cc-vpc', {
  cidrBlock: '10.0.0.0/16',
  enableDnsSupport: true,
  enableDnsHostnames: true,
  tags: { ...tags, Name: 'cobblecompanion' },
});

const igw = new aws.ec2.InternetGateway('cc-igw', {
  vpcId: vpc.id,
  tags: { ...tags, Name: 'cobblecompanion' },
});

// One public subnet in the region's first AZ. A single box needs a single
// subnet; multi-AZ would only matter for an in-VPC database (which we don't run).
const azs = aws.getAvailabilityZonesOutput({ state: 'available' });

export const publicSubnet = new aws.ec2.Subnet('cc-public', {
  vpcId: vpc.id,
  cidrBlock: '10.0.1.0/24',
  availabilityZone: azs.names[0],
  mapPublicIpOnLaunch: true,
  tags: { ...tags, Name: 'cobblecompanion-public' },
});

const routeTable = new aws.ec2.RouteTable('cc-public-rt', {
  vpcId: vpc.id,
  routes: [{ cidrBlock: '0.0.0.0/0', gatewayId: igw.id }],
  tags: { ...tags, Name: 'cobblecompanion-public' },
});

new aws.ec2.RouteTableAssociation('cc-public-rta', {
  subnetId: publicSubnet.id,
  routeTableId: routeTable.id,
});

// EC2 security group: public HTTP(S) in (Caddy terminates TLS); everything out.
// No SSH (port 22) — administration is via SSM Session Manager (see iam.ts), so
// there is no open management port and no key to manage. The app's own port
// (3000) is never exposed: it is published to the instance's loopback only and
// reached solely through Caddy.
export const webSg = new aws.ec2.SecurityGroup('cc-web', {
  vpcId: vpc.id,
  description: 'CobbleCompanion EC2 — public HTTP/HTTPS in, all out.',
  ingress: [
    {
      protocol: 'tcp',
      fromPort: 80,
      toPort: 80,
      cidrBlocks: ['0.0.0.0/0'],
      description: 'HTTP (ACME + redirect to HTTPS)',
    },
    {
      protocol: 'tcp',
      fromPort: 443,
      toPort: 443,
      cidrBlocks: ['0.0.0.0/0'],
      description: 'HTTPS',
    },
  ],
  egress: [
    {
      protocol: '-1',
      fromPort: 0,
      toPort: 0,
      cidrBlocks: ['0.0.0.0/0'],
      description: 'All egress (Supabase, ECR, OpenRouter, ACME)',
    },
  ],
  tags: { ...tags, Name: 'cobblecompanion-web' },
});

export const networkExports = {
  vpcId: vpc.id as pulumi.Output<string>,
  subnetId: publicSubnet.id as pulumi.Output<string>,
};
