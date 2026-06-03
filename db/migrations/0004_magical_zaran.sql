CREATE TABLE "user_token_usage" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"window_reset_at" timestamp with time zone NOT NULL,
	"used_tokens" bigint DEFAULT 0 NOT NULL,
	"cap_override" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_token_usage" ADD CONSTRAINT "user_token_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;