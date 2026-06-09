ALTER TABLE "user_facts" DROP CONSTRAINT "user_facts_superseded_by_user_facts_id_fk";
--> statement-breakpoint
DROP INDEX "user_facts_user_current_idx";--> statement-breakpoint
DROP INDEX "user_facts_one_current_name_uniq";--> statement-breakpoint
ALTER TABLE "companions" ADD COLUMN "user_persona" text;--> statement-breakpoint
ALTER TABLE "companions" ADD COLUMN "user_model_updated_through_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_facts" ADD COLUMN "sensitive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "user_facts_user_predicate_idx" ON "user_facts" USING btree ("user_id","predicate");--> statement-breakpoint
CREATE UNIQUE INDEX "user_facts_one_current_name_uniq" ON "user_facts" USING btree ("user_id","predicate") WHERE "user_facts"."predicate" = 'name';--> statement-breakpoint
ALTER TABLE "user_facts" DROP COLUMN "superseded_at";--> statement-breakpoint
ALTER TABLE "user_facts" DROP COLUMN "superseded_by";