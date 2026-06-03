# infra/github — repository governance (Pulumi)

This Pulumi (TypeScript) project owns CobbleCompanion's **GitHub branch
protection**. Its single job: a pull request cannot be merged into `main` until
the CI `verify` check passes.

It is intentionally separate from [`../gcp`](../gcp/README.md) so the GitHub
admin token never lives in the GCP stack. Same S3 state backend and
`PULUMI_CONFIG_PASSPHRASE` as the rest of `infra/`.

## What it enforces

The rule mirrors `.github/workflows/ci.yml` (job: `verify` → lint, typecheck,
tests at ≥80% coverage):

| Setting                         | Value     | Effect |
|---------------------------------|-----------|--------|
| Required status check           | `verify`  | Merge blocked until CI is green. |
| Require branch up to date       | on (`strict`) | Branch must be rebased/merged onto latest `main` before the check counts. |
| Allow force pushes to `main`    | off       | History on `main` is protected. |
| Allow deletion of `main`        | off       | `main` cannot be deleted. |
| Enforce on admins               | off       | Owner retains an emergency override. |
| Required approving reviews      | none      | Solo repo — self-merge stays possible once CI is green. |

> The required-check name `verify` **must equal the job name** in
> `.github/workflows/ci.yml`. If you rename that job, update `contexts` in
> `index.ts` or merges will block forever waiting on a check that never reports.

## One-time bootstrap

Like the GCP project + OAuth client, the credential Pulumi authenticates *with*
must exist first. The GitHub provider needs a token with admin rights on the
repo:

1. Create a token at <https://github.com/settings/tokens>:
   - **Fine-grained** (recommended): repository access = `CobbleStamp/CobbleCompanion`,
     permission **Administration: Read and write**.
   - or **Classic**: `repo` scope.
2. Export it before running Pulumi (it is not stored in the stack):

   ```bash
   export GITHUB_TOKEN=ghp_xxx
   ```

The repo owner is configured in `Pulumi.dev.yaml` (`github:owner: CobbleStamp`).

## Apply

```bash
cd infra/github
npm install
pulumi stack select dev      # or: pulumi stack init dev
pulumi preview
pulumi up
```

After `pulumi up`, confirm under **Settings → Branches** on GitHub that `main`
shows the rule, then open a throwaway PR and verify the merge button stays
disabled until the `verify` check passes.
