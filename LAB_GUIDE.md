# CircleCI Hands-On Lab (Support Engineer Lens)

A 2-3 hour lab to move from high-level to hands-on. The goal is not to author a perfect pipeline (the wizard does that). It is to build the **mental model** and then deliberately break things so you can say "when a customer hits X, I check Y" with conviction.

Everything below uses a tiny Node/TypeScript repo so CircleCI concepts stay in the foreground.

---

## 0. Setup (15 min)

1. Push the provided `circleci-lab` repo to a fresh GitHub repo (public is fine, keeps you on the free tier).
2. Sign in to CircleCI with that GitHub account, then **Projects > Set Up Project** and point it at the repo. Pick "Fastest" / use the existing `.circleci/config.yml`.
3. Install the CircleCI CLI locally. It is the single most useful support tool because it validates config without a push:
   ```
   curl -fLSs https://raw.githubusercontent.com/CircleCI-Public/circleci-cli/main/install.sh | bash
   circleci config validate        # run from repo root
   ```
   Get used to `circleci config validate`. A large share of "my pipeline won't run" tickets are caught here before anything ever executes.

---

## 1. The mental model (read once, then confirm it in the UI)

Hierarchy, top to bottom. Be able to recite this cold:

- **Pipeline**: the whole run, triggered by a commit. Defined by `.circleci/config.yml` at repo root.
- **Workflow**: orchestrates jobs (order, dependencies via `requires`, fan-out/fan-in, approval gates, filters by branch/tag).
- **Job**: a unit that runs in a single **executor** (Docker / machine / macOS). Has its own environment.
- **Step**: a command inside a job (`checkout`, `run`, `store_artifacts`, etc.).
- **Executor**: where a job runs. `docker:` is most common; `machine:` gives a full VM (needed for Docker-in-Docker, privileged ops); `macOS` for Apple builds.
- **Orb**: a reusable, parameterized config package (`<orb>/<element>`). Public registry + private org orbs. This is CircleCI's most distinctive concept.

Config version note worth knowing cold: **v2.0 support ended 27 June 2026; everything must be `version: 2.1` now.** 2.1 is what unlocks orbs, pipeline parameters, and reusable commands/executors. If a customer's config "suddenly stopped compiling" around now, this is your first hypothesis.

Map it to the provided config: one workflow (`ci`) > one job (`build-and-test`) > steps (checkout, install, lint, build, test, store results/artifacts). The `node` orb's `install-packages` command handles dependency install **and caching automatically**, which is why you do not see a hand-written `save_cache`/`restore_cache` pair.

---

## 2. Green run (20 min)

1. Push, watch it go green in the UI.
2. Click into the job and read each step's output. Specifically open:
   - the **install-packages** step: note the cache restore line ("Found a cache..." vs "No cache found").
   - the **Tests** tab (populated by `store_test_results`).
   - the **Artifacts** tab (your `dist/` output).
3. Push a trivial change (edit a comment) and re-run. Confirm the second run says it **restored the cache**. You have now seen caching work, which matters because broken caching is one of the most common real tickets.

---

## 3. Deliberately break it, then debug (the core of the lab, ~70 min)

Do these one at a time. For each: make the change, push, read the failure, form the hypothesis *before* you confirm the fix. Write yourself one sentence per break in the "support script" format. That sentence is what you will actually say in the interview.

### Break A: YAML / syntax error
Change `version: 2.1` to `version: 2` (or mis-indent a step by one space).
- **What you'll see**: the pipeline fails to even start; a config-compilation error, not a job failure.
- **The lesson**: config errors surface *before* any job runs and look different from runtime failures. First triage question for any "pipeline broken" ticket: did it fail to **compile**, or did a **job** fail? Different root causes entirely.
- **Support sentence**: "When a customer says the pipeline is broken, I first check whether it failed to compile or a job failed, because that splits the problem space immediately. With v2.0 support ending in June 2026, a config that compiled last week and not this week is an immediate version-bump suspect."

### Break B: cache key confusion
In `.circleci/config.yml`, replace the orb's `node/install-packages` with a hand-written cache + install so you can see the moving parts:
```yaml
      - restore_cache:
          keys:
            - deps-v1-{{ checksum "package-lock.json" }}
      - run: npm ci
      - save_cache:
          key: deps-v1-{{ checksum "package-lock.json" }}
          paths:
            - ~/.npm
```
Now push twice. Then change the cache `key` prefix (`deps-v1` to `deps-v2`) and watch a cold cache happen.
- **The lesson**: CircleCI caches are **immutable** once written for a given key; you never overwrite a key, you roll the key (or bump a version prefix) to invalidate. The `checksum` of the lockfile is what makes the key change when deps change. `restore_cache` uses a *prefix* match and falls through a list of keys.
- **Common customer bug**: stale dependencies because the cache key does not include the lockfile checksum, so it never invalidates. Or the opposite: a key so specific it never hits, so every build is a cold install (slow, burns credits).
- **Support sentence**: "If a customer reports stale deps, I check whether their cache key includes the lockfile checksum. If they report every build doing a full cold install, I check whether the key is too specific to ever hit."

### Break C: a secret / env var that isn't set
Add a step that needs an env var the job doesn't have:
```yaml
      - run:
          name: Needs a secret
          command: echo "Deploying with $DEPLOY_TOKEN" && test -n "$DEPLOY_TOKEN"
```
Push (it fails, var is empty). Then fix it the right way: in the CircleCI UI create a **Context** (Org Settings > Contexts), add `DEPLOY_TOKEN`, and attach the context to the job in the workflow:
```yaml
workflows:
  ci:
    jobs:
      - build-and-test:
          context: my-secrets
```
- **The lesson**: secrets live in **project env vars** or, better, **Contexts** (shareable across projects, restrictable by group). They are **not** in the config file. A frequent ticket: "my deploy works locally but not in CI" because the env var was never set in the project/context, or the context wasn't attached to the job.
- **Security point worth saying out loud**: env vars are masked in logs; you never commit secrets to config. This signals you think about security, which their JD explicitly calls out.
- **Support sentence**: "For 'works locally, fails in CI' on anything credential-shaped, I check whether the var is set in the project or a context, and whether that context is actually attached to the job."

### Break D: a flaky / failing test and the workflow dependency graph
Make one test fail (change `expect(add(2, 3)).toBe(5)` to `.toBe(6)`). Then add a second job that depends on the first:
```yaml
  deploy:
    docker:
      - image: cimg/base:stable
    steps:
      - run: echo "pretend deploy"

workflows:
  ci:
    jobs:
      - build-and-test
      - deploy:
          requires:
            - build-and-test
```
Push. Watch `deploy` **not run** because its required upstream job failed.
- **The lesson**: `requires` is how you build the DAG. A downstream job is skipped if an upstream one fails, which is the whole point of gating deploys behind tests. Customers often ask "why didn't my deploy run?" and the answer is usually an upstream failure or an unmet branch filter.
- **Support sentence**: "When a deploy job 'didn't run', I check the workflow graph: an upstream `requires` job failed, or a branch/tag filter excluded it."

---

## 4. One step up: test splitting (optional, ~30 min if you have it)

This is CircleCI's signature performance feature and a frequent source of "why isn't my parallelism working" tickets, so it is high-value to have touched.

Add `parallelism` and split by timing. Note the per-container output filename (`junit-$CIRCLE_NODE_INDEX.xml`): each parallel container writes its own JUnit file, otherwise they would overwrite a single shared file and you would lose results. This collision is itself a common real-world gotcha.
```yaml
  build-and-test:
    docker:
      - image: cimg/node:20.11
    parallelism: 2
    steps:
      - checkout
      - node/install-packages:
          pkg-manager: npm
      - run:
          name: Run tests (split by timing)
          command: |
            TESTFILES=$(circleci tests glob "src/**/*.test.ts" | circleci tests split --split-by=timings)
            npx vitest run $TESTFILES --reporter=default --reporter=junit \
              --outputFile=./test-results/junit-$CIRCLE_NODE_INDEX.xml
      - store_test_results:
          path: ./test-results
```
Vitest takes the file list as positional arguments (`vitest run <files>`), so the split output from `circleci tests split` is passed straight through. (Vitest also has a native `--shard=N/M` flag, but using CircleCI's `tests split` is what mirrors a customer setup and feeds the timing data back, so prefer it here.)
- **First run** splits by name (no timing data yet). **Subsequent runs** split by **timing**, because `store_test_results` fed historical data back. This cause-and-effect is the thing most people miss.
- **The classic ticket**: "I set parallelism to 4 but my build isn't 4x faster." Real answers: fixed per-container overhead (spin-up, checkout, install happen on every container), uneven splits without timing data, or a test suite too small to benefit. Being able to explain *why* parallelism is sub-linear is a strong, concrete signal.
- **Support sentence**: "If parallelism isn't speeding things up, I check whether `store_test_results` is present (no timing data means uneven splits), and I remind them that per-container overhead is fixed, so speedup is always sub-linear."

---

## 5. Wrap-up: what to actually retain for the interview

You do not need to memorize YAML. You need the **triage reflexes**. If you can finish each of these sentences naturally, you are ready to talk about CircleCI with genuine competence:

- "Pipeline broken" -> compile failure vs job failure first.
- Stale deps / slow installs -> cache key and lockfile checksum.
- Works locally, fails in CI -> env var in project/context, context attached?
- Deploy didn't run -> upstream `requires` failure or branch filter.
- Parallelism not helping -> timing data present? fixed overhead is sub-linear.
- Config compiled last week, not this week -> v2.0 end-of-life (27 June 2026) is a live suspect.

A note on framing for a Staff-level conversation: when you tell these stories, push past "I'd resolve the ticket" to "I'd look for the pattern." E.g. "If multiple customers hit the same cache-invalidation confusion, that's a docs gap or a default worth raising with Product," which mirrors the root-cause-elimination language in their JD.

---

## Files in this lab

- `.circleci/config.yml` - the clean starting config
- `package.json`, `tsconfig.json`, `vitest.config.ts` - minimal Node/TS setup
- `src/math.ts` + `src/__tests__/math.test.ts` - trivial code with 4 tests (enough to break, fail, and split)
