CREATE TABLE "companion_energy" (
	"companion_id" uuid PRIMARY KEY NOT NULL,
	"window_reset_at" timestamp with time zone NOT NULL,
	"used_tokens" bigint DEFAULT 0 NOT NULL,
	"cap_override" integer,
	"top_up_tokens" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companions" ADD COLUMN "proactivity_dial" text DEFAULT 'gentle' NOT NULL;--> statement-breakpoint
ALTER TABLE "companions" ADD COLUMN "personality_knobs" jsonb;--> statement-breakpoint
ALTER TABLE "companions" ADD COLUMN "drive_weights" jsonb;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "origin" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "companion_energy" ADD CONSTRAINT "companion_energy_companion_id_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE cascade ON UPDATE no action;