CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"companion_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"fact_type" text NOT NULL,
	"subject" text NOT NULL,
	"predicate" text,
	"object" text NOT NULL,
	"confidence" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestion_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"companion_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"sections_total" integer DEFAULT 0 NOT NULL,
	"sections_done" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"companion_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"chapter_title" text,
	"topic_title" text NOT NULL,
	"original_text" text NOT NULL,
	"context_header" text,
	"para_start" integer NOT NULL,
	"para_end" integer NOT NULL,
	"page_start" integer,
	"page_end" integer,
	"ord" integer NOT NULL,
	"embedding" vector(1024),
	"fts" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', original_text)) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"companion_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"origin" text,
	"raw_text" text NOT NULL,
	"byte_size" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_companion_id_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_section_id_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_companion_id_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_companion_id_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_companion_id_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "facts_companion_idx" ON "facts" USING btree ("companion_id","fact_type");--> statement-breakpoint
CREATE INDEX "facts_section_idx" ON "facts" USING btree ("section_id");--> statement-breakpoint
CREATE INDEX "ingestion_jobs_companion_idx" ON "ingestion_jobs" USING btree ("companion_id","status");--> statement-breakpoint
CREATE INDEX "sections_companion_idx" ON "sections" USING btree ("companion_id");--> statement-breakpoint
CREATE INDEX "sections_source_idx" ON "sections" USING btree ("source_id","ord");--> statement-breakpoint
CREATE INDEX "sections_embedding_hnsw_idx" ON "sections" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "sections_fts_idx" ON "sections" USING gin ("fts");--> statement-breakpoint
CREATE INDEX "sources_companion_idx" ON "sources" USING btree ("companion_id");