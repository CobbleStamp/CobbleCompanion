interface SignInProps {
  readonly onSignIn: () => void;
}

/** Step 1 of the walking skeleton: sign in with Google via Auth0. */
export function SignIn({ onSignIn }: SignInProps): JSX.Element {
  return (
    <main className="card">
      <h1>CobbleCompanion</h1>
      <p>Sign in to raise your companion.</p>
      <button type="button" onClick={onSignIn}>
        Continue with Google
      </button>
    </main>
  );
}
