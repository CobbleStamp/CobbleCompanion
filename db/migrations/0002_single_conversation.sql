ALTER TABLE "messages" ADD COLUMN "companion_id" uuid;--> statement-breakpoint
UPDATE "messages" AS "m" SET "companion_id" = "c"."companion_id" FROM "conversations" AS "c" WHERE "m"."conversation_id" = "c"."id";--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "companion_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_companion_id_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."companions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
DROP INDEX "messages_conversation_idx";--> statement-breakpoint
CREATE INDEX "messages_companion_idx" ON "messages" USING btree ("companion_id","seq");--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "conversation_id";--> statement-breakpoint
DROP TABLE "conversations" CASCADE;
