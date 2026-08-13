## Isogloss — one-command operations.

COMPOSE := docker compose
PSQL    := $(COMPOSE) exec -T db psql -U isogloss -d isogloss

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

.PHONY: check-docker
check-docker:
	@docker info >/dev/null 2>&1 || { \
	  echo "Docker daemon is not running. Start Docker Desktop, then re-run."; \
	  exit 1; }

.PHONY: up
up: check-docker ## Build and start PostGIS + the API (seeds the field on first run)
	$(COMPOSE) up --build -d
	@$(MAKE) --no-print-directory wait
	@echo "ready → http://localhost:$${API_PORT:-8000}"

.PHONY: wait
wait: ## Block until the field has finished building
	@echo "waiting for the field to build…"
	@for i in $$(seq 1 150); do \
	  if $(PSQL) -tAc 'SELECT count(*)>0 FROM site_cell' 2>/dev/null | grep -q t; then exit 0; fi; \
	  sleep 2; done; \
	echo "timed out; check 'make logs'"; exit 1

.PHONY: reseed
reseed: check-docker ## Wipe the volume and rebuild the whole field from db/*.sql
	$(COMPOSE) down -v
	$(COMPOSE) up --build -d
	@$(MAKE) --no-print-directory wait
	@$(MAKE) --no-print-directory regions
	@$(MAKE) --no-print-directory stats

.PHONY: down
down: ## Stop and remove containers
	$(COMPOSE) down

.PHONY: nuke
nuke: ## Stop and delete the database volume (re-seeds on next `up`)
	$(COMPOSE) down -v

.PHONY: logs
logs: ## Tail logs
	$(COMPOSE) logs -f

.PHONY: health
health: ## Check the API
	@curl -fsS localhost:$${API_PORT:-8000}/health; echo

.PHONY: psql
psql: ## Open a psql shell on the field
	$(COMPOSE) exec db psql -U isogloss -d isogloss

.PHONY: refresh
refresh: ## Rebuild every derived layer (edges, cells, isoglosses, bundles)
	@$(PSQL) -c 'SELECT * FROM iso_refresh_all();'

.PHONY: regions
regions: ## Recluster dialect regions in every study area
	@for a in gb-ie na anz; do \
		curl -fsS -X POST "localhost:$${API_PORT:-8000}/api/regions/rebuild?area=$$a&language=en&k=6" >/dev/null \
		&& echo "clustered $$a"; done

.PHONY: stats
stats: ## Row counts across the field
	@$(PSQL) -c "SELECT 'sites' t, count(*) FROM accent_site \
	  UNION ALL SELECT 'features', count(*) FROM site_feature \
	  UNION ALL SELECT 'settlements', count(*) FROM settlement \
	  UNION ALL SELECT 'edges', count(*) FROM interaction_edge \
	  UNION ALL SELECT 'cells', count(*) FROM site_cell \
	  UNION ALL SELECT 'isoglosses', count(*) FROM isogloss \
	  UNION ALL SELECT 'bundles', count(*) FROM isogloss_bundle \
	  UNION ALL SELECT 'regions', count(*) FROM dialect_region;"

.PHONY: test
test: ## Run the offline DSP/pipeline checks (no database needed)
	python3 backend/tests/test_dsp.py

.PHONY: demo
demo: ## Run a hierarchical diffusion from London and print the signature
	@curl -fsS -X POST localhost:$${API_PORT:-8000}/api/diffusion/run \
		-H 'Content-Type: application/json' \
		-d '{"regime":"hierarchical","origin":"london","area":"gb-ie","steps":24}' \
		| python3 -c 'import json,sys; d=json.load(sys.stdin); \
		print("run", d["run_id"], d["regime"]); print("signature", d["signature"]); \
		print("first adopters:", ", ".join(r["name"] for r in d["order"][:12]))'
