CREATE TABLE "episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"companion_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"seq_start" bigint NOT NULL,
	"seq_end" bigint NOT NULL,
	"occurred_start" timestamp with time zone NOT NULL,
	"occurred_end" timestamp with time zone NOT NULL,
	"salience" real,
	"embedding" vector(1024),
	"fts" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', summary)) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companions" ADD COLUMN "evolved_persona" text;--> statement-breakpoint
ALTER TABLE "companions" ADD COLUMN "persona_updated_through_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "companions" ADD COLUMN "consolidated_through_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_companion_id_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "episodes_companion_time_idx" ON "episodes" USING btree ("companion_id","occurred_end");--> statement-breakpoint
CREATE INDEX "episodes_companion_seq_idx" ON "episodes" USING btree ("companion_id","seq_end");--> statement-breakpoint
CREATE INDEX "episodes_embedding_hnsw_idx" ON "episodes" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "episodes_fts_idx" ON "episodes" USING gin ("fts");