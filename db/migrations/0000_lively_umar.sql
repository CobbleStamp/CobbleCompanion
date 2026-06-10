CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "companion_affect" (
	"companion_id" uuid PRIMARY KEY NOT NULL,
	"valence" real NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companion_growth" (
	"companion_id" uuid PRIMARY KEY NOT NULL,
	"knowledge_band" integer DEFAULT 0 NOT NULL,
	"bond_band" integer DEFAULT 0 NOT NULL,
	"initiative_band" integer DEFAULT 0 NOT NULL,
	"observed_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"form" text NOT NULL,
	"temperament" text NOT NULL,
	"evolved_persona" text,
	"persona_updated_through_seq" bigint DEFAULT 0 NOT NULL,
	"consolidated_through_seq" bigint DEFAULT 0 NOT NULL,
	"user_facts_through_seq" bigint DEFAULT 0 NOT NULL,
	"user_persona" text,
	"user_model_updated_through_seq" bigint DEFAULT 0 NOT NULL,
	"proactivity_dial" text DEFAULT 'gentle' NOT NULL,
	"personality_knobs" jsonb,
	"drive_weights" jsonb,
	"stamina_balance_tokens" bigint DEFAULT 1000000 NOT NULL,
	"energy_balance_tokens" bigint DEFAULT 1000000 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
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
CREATE TABLE "equipped_tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"companion_id" uuid NOT NULL,
	"tool_id" text NOT NULL,
	"source" text NOT NULL,
	"server_ref" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"equipped_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
	"parsed_doc" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"companion_id" uuid NOT NULL,
	"url" text NOT NULL,
	"why" text,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"companion_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"kind" text DEFAULT 'message' NOT NULL,
	"metadata" jsonb,
	"source_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proactive_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"companion_id" uuid NOT NULL,
	"note_message_id" uuid,
	"proposal_id" uuid,
	"drive" text NOT NULL,
	"drive_snapshot" jsonb,
	"driven_by_user_fact_id" uuid,
	"reward" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "procedural_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"companion_id" uuid NOT NULL,
	"title" text NOT NULL,
	"steps" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"companion_id" uuid NOT NULL,
	"lead_id" uuid,
	"origin" text DEFAULT 'chat' NOT NULL,
	"tool_name" text NOT NULL,
	"tool_args" jsonb NOT NULL,
	"tool_call_id" text,
	"summary" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
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
CREATE TABLE "tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"companion_id" uuid NOT NULL,
	"name" text NOT NULL,
	"args" jsonb NOT NULL,
	"result" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_catalog" (
	"tool_id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"server_ref" text NOT NULL,
	"tool_name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"learned_by_companion_id" uuid,
	"learned_from_seq" bigint,
	"fact_type" text NOT NULL,
	"subject" text NOT NULL,
	"predicate" text,
	"object" text NOT NULL,
	"confidence" real,
	"salience" real,
	"sensitive" boolean DEFAULT false NOT NULL,
	"embedding" vector(1024),
	"fts" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(subject, '') || ' ' || coalesce(predicate, '') || ' ' || coalesce(object, ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_food" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"ration" integer NOT NULL,
	"spark" integer NOT NULL,
	"treat" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "companion_affect" ADD CONSTRAINT "companion_affect_companion_id_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion_growth" ADD CONSTRAINT "companion_growth_companion_id_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companions" ADD CONSTRAINT "companions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_companion_id_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipped_tools" ADD CONSTRAINT "equipped_tools_companion_id_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_companion_id_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_section_id_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_companion_id_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_companion_id_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_companion_id_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_outcomes" ADD CONSTRAINT "proactive_outcomes_companion_id_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_outcomes" ADD CONSTRAINT "proactive_outcomes_note_message_id_messages_id_fk" FOREIGN KEY ("note_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_outcomes" ADD CONSTRAINT "proactive_outcomes_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_outcomes" ADD CONSTRAINT "proactive_outcomes_driven_by_user_fact_id_user_facts_id_fk" FOREIGN KEY ("driven_by_user_fact_id") REFERENCES "public"."user_facts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedural_memories" ADD CONSTRAINT "procedural_memories_companion_id_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_companion_id_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_companion_id_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_companion_id_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_companion_id_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_facts" ADD CONSTRAINT "user_facts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_facts" ADD CONSTRAINT "user_facts_learned_by_companion_id_companions_id_fk" FOREIGN KEY ("learned_by_companion_id") REFERENCES "public"."companions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_food" ADD CONSTRAINT "user_food_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "companions_owner_idx" ON "companions" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "episodes_companion_time_idx" ON "episodes" USING btree ("companion_id","occurred_end");--> statement-breakpoint
CREATE INDEX "episodes_companion_seq_idx" ON "episodes" USING btree ("companion_id","seq_end");--> statement-breakpoint
CREATE INDEX "episodes_embedding_hnsw_idx" ON "episodes" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "episodes_fts_idx" ON "episodes" USING gin ("fts");--> statement-breakpoint
CREATE UNIQUE INDEX "equipped_tools_companion_tool_uniq" ON "equipped_tools" USING btree ("companion_id","tool_id");--> statement-breakpoint
CREATE INDEX "equipped_tools_companion_lru_idx" ON "equipped_tools" USING btree ("companion_id","last_used_at");--> statement-breakpoint
CREATE INDEX "facts_companion_idx" ON "facts" USING btree ("companion_id","fact_type");--> statement-breakpoint
CREATE INDEX "facts_section_idx" ON "facts" USING btree ("section_id");--> statement-breakpoint
CREATE INDEX "ingestion_jobs_companion_idx" ON "ingestion_jobs" USING btree ("companion_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_companion_url_uniq" ON "leads" USING btree ("companion_id","url");--> statement-breakpoint
CREATE INDEX "leads_companion_status_idx" ON "leads" USING btree ("companion_id","status");--> statement-breakpoint
CREATE INDEX "messages_companion_idx" ON "messages" USING btree ("companion_id","seq");--> statement-breakpoint
CREATE INDEX "proactive_outcomes_companion_idx" ON "proactive_outcomes" USING btree ("companion_id","seq");--> statement-breakpoint
CREATE INDEX "proactive_outcomes_proposal_idx" ON "proactive_outcomes" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "procedural_companion_idx" ON "procedural_memories" USING btree ("companion_id","seq");--> statement-breakpoint
CREATE INDEX "proposals_companion_status_idx" ON "proposals" USING btree ("companion_id","status");--> statement-breakpoint
CREATE INDEX "sections_companion_idx" ON "sections" USING btree ("companion_id");--> statement-breakpoint
CREATE INDEX "sections_source_idx" ON "sections" USING btree ("source_id","ord");--> statement-breakpoint
CREATE INDEX "sections_embedding_hnsw_idx" ON "sections" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "sections_fts_idx" ON "sections" USING gin ("fts");--> statement-breakpoint
CREATE INDEX "sources_companion_idx" ON "sources" USING btree ("companion_id");--> statement-breakpoint
CREATE INDEX "tool_calls_companion_idx" ON "tool_calls" USING btree ("companion_id","seq");--> statement-breakpoint
CREATE INDEX "user_facts_user_predicate_idx" ON "user_facts" USING btree ("user_id","predicate");--> statement-breakpoint
CREATE INDEX "user_facts_embedding_hnsw_idx" ON "user_facts" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "user_facts_fts_idx" ON "user_facts" USING gin ("fts");--> statement-breakpoint
CREATE UNIQUE INDEX "user_facts_one_current_name_uniq" ON "user_facts" USING btree ("user_id","predicate") WHERE "user_facts"."predicate" = 'name';