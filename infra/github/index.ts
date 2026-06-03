// CobbleCompanion GitHub governance stack. See infra/github/README.md for the
// one-time token bootstrap and apply order.
//
// The repository itself is created out-of-band on GitHub; this stack only
// manages its branch-protection rules, so we reference the repo by name rather
// than declaring it.
import * as github from '@pulumi/github';

const repoName: string = 'CobbleCompanion';

// Protect `main`: a PR cannot be merged unless the CI `verify` job
// (see .github/workflows/ci.yml — runs lint, typecheck, and tests at >=80%
// coverage) reports success. The status-check context name must match the
// workflow's job name exactly. `strict: true` additionally requires the PR
// branch to be up to date with main before the check counts, so a branch that
// passed CI in isolation but breaks against newer main cannot merge.
// Force-pushing to and deleting `main` are both blocked.
export const mainProtection: github.BranchProtection = new github.BranchProtection(
  'main',
  {
    repositoryId: repoName,
    pattern: 'main',
    requiredStatusChecks: [
      {
        strict: true,
        contexts: ['verify'],
      },
    ],
    allowsForcePushes: false,
    allowsDeletions: false,
  },
);

export const protectedBranch = mainProtection.pattern;
export const requiredChecks = mainProtection.requiredStatusChecks;
