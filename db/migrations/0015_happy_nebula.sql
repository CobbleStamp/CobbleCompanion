CREATE TABLE "companion_affect" (
	"companion_id" uuid PRIMARY KEY NOT NULL,
	"valence" real NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companion_affect" ADD CONSTRAINT "companion_affect_companion_id_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE cascade ON UPDATE no action;