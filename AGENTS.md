# Rules for DeepSeek: kubeos-dashboard

Read this file at the start of every session and follow it for the whole session.
If a rule here conflicts with what you were about to do, the rule wins. If you are unsure, ask me.

## 1. Project overview

- **kubeos-dashboard** is the web dashboard for **KubeOS**, built on top of **Headlamp** (the Headlamp repo is cloned on the host).
- The dashboard is used to manage a real KubeOS system, so features must work against a real cluster, not mocks.
- The **KubeOS CLI** (separate project, about 90% complete) installs and configures the KubeOS system. The dashboard depends on what the CLI deploys.

## 2. Infrastructure (already set up)

- **Builder VM** (KVM): development and build environment. You have SSH access.
- **KubeOS VM** (KVM): a real KubeOS system installed for testing. You have SSH access.
- **Host**: you may create and manage docker pods/containers here to deploy the dashboard for testing. I open it in the browser and tell you what to add or change based on how it looks.
- Permissions already given: SSH to both VMs, docker pods on the host. Do not exceed these (see section 5).

## 3. Git rules (IMPORTANT)

1. **Never commit or push without asking me first.** This applies to every change, including small ones. Do not auto-commit or auto-push.
2. Before asking, show me:
   - which repo/machine (host, builder VM)
   - which files changed
   - a short summary of the changes
   - the proposed commit message
3. Wait for my explicit approval ("yes", "commit", "push") for each commit and push.
4. **Default branch is `development`.** Push only to `development`.
5. **Never push to `main`** unless I clearly say so in that message (for example "push to main"). Earlier permission does not carry over. Ask again each time.
6. Never force-push, rewrite history, delete branches, or change remotes without asking.
7. Group small changes together. Do not propose a commit for every tiny edit. Ask when a logical piece of work is finished or when I tell you to.

## 4. Keep local copies in sync

- The repo exists on the **host** and on the **builder VM**. Keep both in sync with every change.
- After editing in one place, make sure the other has the same state (copy, pull or rsync as appropriate). Tell me if they ever diverge.
- Syncing locally is allowed without asking. Pushing to GitHub is not (section 3).

## 5. Boundaries

- Stay within the dashboard work. Do not modify the KubeOS system VM's configuration beyond what is needed to test the dashboard, and tell me what you changed there.
- Do not touch the KubeOS CLI code from this session. The CLI is changed in a separate KubeOS workspace session (section 6).
- Do not delete VMs, volumes, images, or data outside the dashboard's test containers without asking.
- Do not expose services outside the local machine and VMs.
- Do not store secrets, tokens, or SSH keys in the repo.

## 6. Dashboard needs a CLI change: report it, do not guess

While developing and testing the dashboard, you will often find that a feature needs something the KubeOS CLI does not install or configure yet.

**Example:** the CLI did not deploy metrics-server, so the dashboard showed "metrics server not found" for CPU and RAM.

When this happens:

1. **Stop and tell me.** Do not work around it silently, and do not hack the cluster by hand and move on, unless I tell you to do it temporarily for testing.
2. Add the item to the running list in `CLI_REQUIREMENTS.md` at the repo root (create it if missing), and also tell me in chat.
3. For each item, write it so I can paste it into a KubeOS CLI session without extra context:

```
### <short title>
- Dashboard feature affected: <page / feature>
- Symptom seen: <exact error or behavior>
- What the CLI must add or change: <package, pod, manifest, namespace, flag, RBAC, service, config...>
- Where it should run: <e.g. kube-system, at install time, post-install step>
- How to verify it works: <command to run on the KubeOS VM and expected output>
- Temporary workaround used for testing (if any): <what you did by hand, so I can confirm it matches the final CLI behavior>
```

4. If you did a manual workaround on the KubeOS VM for testing, list the exact commands and manifests you used. The CLI must reproduce them.
5. Keep this list current. At the end of a session, give me a summary of all open CLI requirements.

Things to watch for: required pods or controllers (metrics-server, ingress, storage), RBAC and service accounts, ports and services, namespaces, config files, package or image dependencies, and anything the dashboard expects to exist after a fresh KubeOS install.

## 7. Testing workflow

- Deploy the dashboard in docker on the host and tell me the URL to open.
- After a change, tell me what to look at in the browser and what you expect to see.
- Test against the real KubeOS VM, not fake data, whenever possible.
- When something fails, report the real error, what you checked, and your suspected cause. Do not claim it works unless you tested it.

## 8. Communication style

- Be concise and clear. I may not know every technical detail, so explain briefly what you did and why.
- Ask one clear question at a time when you need a decision.
- Do not make large changes (restructuring, dependency upgrades, mass renames) without telling me the plan first.
- If my request is unclear, ask before building.

## 9. Session start checklist

At the beginning of each session:

1. Confirm the current branch on host and builder VM (should be `development`).
2. Confirm host and builder VM repos are in sync.
3. Check `CLI_REQUIREMENTS.md` for open items and remind me of them.
4. Ask what I want to work on.
