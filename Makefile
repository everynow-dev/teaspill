# teaspill — thin dev-loop wrapper around `docker compose` (0001:T1.1).
#
# Intentionally minimal: three targets, no magic. The richer `platform dev`
# CLI (compose up + local agent-loop/executor service registration with
# retry-until-gateway-healthy + tailed, rendered logs — see work/plans/0001-build-v1/PLAN.md 0001:T6.2)
# supersedes this once it exists. Until then, this is the lowest-common-
# denominator entrypoint for anyone who hasn't built the CLI yet.

.PHONY: dev down logs config

dev: .env ## Start the self-host stack (detached).
	docker compose up -d

down: ## Stop and remove the stack's containers (named volumes persist).
	docker compose down

logs: ## Follow logs for all services.
	docker compose logs -f

config: ## Validate & print the fully-resolved compose config.
	docker compose config

.env:
	@echo "No .env found — copying .env.example (edit it if you want non-default ports/credentials)."
	cp .env.example .env
