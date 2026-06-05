CREATE TABLE "proactive_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"companion_id" uuid NOT NULL,
	"proposal_id" uuid,
	"drive" text NOT NULL,
	"drive_snapshot" jsonb,
	"reward" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "proactive_outcomes" ADD CONSTRAINT "proactive_outcomes_companion_id_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_outcomes" ADD CONSTRAINT "proactive_outcomes_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proactive_outcomes_companion_idx" ON "proactive_outcomes" USING btree ("companion_id","seq");--> statement-breakpoint
CREATE INDEX "proactive_outcomes_proposal_idx" ON "proactive_outcomes" USING btree ("proposal_id");