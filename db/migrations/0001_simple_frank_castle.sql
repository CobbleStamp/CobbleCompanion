CREATE TABLE "discord_config" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"encrypted_bot_token" text NOT NULL,
	"bound_companion_id" uuid NOT NULL,
	"owner_discord_user_id" text,
	"link_code" text,
	"link_code_issued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discord_config" ADD CONSTRAINT "discord_config_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_config" ADD CONSTRAINT "discord_config_bound_companion_id_companions_id_fk" FOREIGN KEY ("bound_companion_id") REFERENCES "public"."companions"("id") ON DELETE cascade ON UPDATE no action;