ALTER TABLE "companions" ADD COLUMN "user_facts_through_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "proactive_outcomes" ADD COLUMN "driven_by_user_fact_id" uuid;--> statement-breakpoint
ALTER TABLE "user_facts" ADD COLUMN "salience" real;--> statement-breakpoint
ALTER TABLE "user_facts" ADD COLUMN "embedding" vector(1024);--> statement-breakpoint
ALTER TABLE "user_facts" ADD COLUMN "fts" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(subject, '') || ' ' || coalesce(predicate, '') || ' ' || coalesce(object, ''))) STORED;--> statement-breakpoint
ALTER TABLE "proactive_outcomes" ADD CONSTRAINT "proactive_outcomes_driven_by_user_fact_id_user_facts_id_fk" FOREIGN KEY ("driven_by_user_fact_id") REFERENCES "public"."user_facts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_facts_embedding_hnsw_idx" ON "user_facts" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "user_facts_fts_idx" ON "user_facts" USING gin ("fts");