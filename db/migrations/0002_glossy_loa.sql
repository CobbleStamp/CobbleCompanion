CREATE TABLE "mission_journal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"mission_id" uuid NOT NULL,
	"event" text,
	"findings" text,
	"prediction" text,
	"decision" text,
	"turn_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "missions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"companion_id" uuid NOT NULL,
	"goal" text NOT NULL,
	"plan" text,
	"validation_criteria" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"job_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"report_channel" text,
	"outward_grant" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discord_config" ADD COLUMN "trigger_bot_id" text;--> statement-breakpoint
ALTER TABLE "discord_config" ADD COLUMN "mission_channel_id" text;--> statement-breakpoint
ALTER TABLE "mission_journal" ADD CONSTRAINT "mission_journal_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_companion_id_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mission_journal_mission_seq_idx" ON "mission_journal" USING btree ("mission_id","seq");--> statement-breakpoint
CREATE INDEX "missions_companion_status_idx" ON "missions" USING btree ("companion_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "missions_one_active_per_companion_uniq" ON "missions" USING btree ("companion_id") WHERE status = 'active';