CREATE TABLE "companion_growth" (
	"companion_id" uuid PRIMARY KEY NOT NULL,
	"knowledge_band" integer DEFAULT 0 NOT NULL,
	"bond_band" integer DEFAULT 0 NOT NULL,
	"initiative_band" integer DEFAULT 0 NOT NULL,
	"observed_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"treats" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companion_growth" ADD CONSTRAINT "companion_growth_companion_id_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE cascade ON UPDATE no action;