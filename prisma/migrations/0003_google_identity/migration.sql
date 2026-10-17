-- Sign in / sign up with Google: the stable Google account id (`sub`) of a user.
ALTER TABLE "users" ADD COLUMN "google_sub" TEXT;
CREATE UNIQUE INDEX "users_google_sub_key" ON "users"("google_sub");
