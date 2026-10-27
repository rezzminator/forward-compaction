# Every check the release workflow runs on a develop -> main pull request, run
# the same way here first. CI's runner has Node 22 already; locally mise gives it.
RUN := $(if $(CI),,mise exec node@22 --)
MANIFEST := plugins/forward-compaction/.claude-plugin/plugin.json
# main before the rename to forward-compaction carries the manifest here.
OLD_MANIFEST := plugins/sub-agent-compact/.claude-plugin/plugin.json

.PHONY: release-check deps check release

release-check: check release

deps:
	$(RUN) npm ci

check: deps
	$(RUN) npm test
	$(RUN) npm run typecheck
	CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 $(RUN) npm run validate:plugin

# Run `git fetch origin main` first: the version must move past main's.
release: deps
	@git rev-parse --verify -q origin/main >/dev/null || { echo "FAIL origin/main is missing from the checkout: run git fetch origin main"; exit 1; }
	@v=$$($(RUN) node -p 'require("./$(MANIFEST)").version'); \
	case "$$v" in *-*) echo "FAIL $$v is a pre-release: every merge into main publishes, so the release version carries no -suffix"; exit 1 ;; esac
	base=$$(for m in "$(MANIFEST)" "$(OLD_MANIFEST)"; do if git cat-file -e "origin/main:$$m" 2>/dev/null; then git show "origin/main:$$m" | $(RUN) node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version'; exit; fi; done; echo "main has neither $(MANIFEST) nor $(OLD_MANIFEST): treating this as the first release" >&2; echo 0.0.0) && \
	$(RUN) scripts/release-check.sh "$$base"
	v=$$($(RUN) node -p 'require("./$(MANIFEST)").version'); \
	awk -v v="$$v" '$$0 ~ "^## \\[" v "\\]" {f=1; next} /^## \[/ || /^\[/ {f=0} f' CHANGELOG.md | grep -q '' || { echo "FAIL CHANGELOG.md section for $$v yields no release notes"; exit 1; }
