CREATE TABLE "service_registry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"secret" text NOT NULL,
	"secret_type" text DEFAULT 'plaintext' NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auth_source" text DEFAULT 'google' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "service_client_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "external_id" text;--> statement-breakpoint
CREATE INDEX "service_registry_client_idx" ON "service_registry" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_registry_client_secret_uniq" ON "service_registry" USING btree ("client_id","secret");--> statement-breakpoint
CREATE UNIQUE INDEX "users_auth_source_client_external_uniq" ON "users" USING btree ("auth_source","service_client_id","external_id") WHERE "users"."external_id" is not null;