ALTER TABLE "companion_growth" DROP COLUMN "knowledge_level";--> statement-breakpoint
ALTER TABLE "companion_growth" DROP COLUMN "relationship_level";--> statement-breakpoint
ALTER TABLE "companion_growth" DROP COLUMN "unlocked_abilities";--> statement-breakpoint
ALTER TABLE "companion_growth" DROP COLUMN "overall_stage";--> statement-breakpoint
ALTER TABLE "companion_growth" ADD COLUMN "knowledge_band" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "companion_growth" ADD COLUMN "bond_band" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "companion_growth" ADD COLUMN "initiative_band" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "companion_growth" ADD COLUMN "observed_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL;
