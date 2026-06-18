CREATE TABLE "companion_events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"companion_id" uuid NOT NULL,
	"event" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companion_events" ADD CONSTRAINT "companion_events_companion_id_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "companion_events_companion_seq_idx" ON "companion_events" USING btree ("companion_id","seq");