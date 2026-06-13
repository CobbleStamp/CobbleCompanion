CREATE TABLE "message_reactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"companion_id" uuid NOT NULL,
	"reactor" text NOT NULL,
	"emoji" text NOT NULL,
	"reward" real,
	"reward_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_companion_id_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_reactions_uniq" ON "message_reactions" USING btree ("message_id","reactor","emoji");--> statement-breakpoint
CREATE INDEX "message_reactions_companion_idx" ON "message_reactions" USING btree ("companion_id");