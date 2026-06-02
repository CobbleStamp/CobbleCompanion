import { useAuth0 } from '@auth0/auth0-react';
import { useEffect } from 'react';
import { setAccessTokenGetter } from '../api/client.js';

/**
 * Wires Auth0's `getAccessTokenSilently` into the API client so requests carry
 * a bearer token. Renders nothing. Mounted inside <Auth0Provider/>.
 */
export function AuthBridge(): null {
  const { getAccessTokenSilently, isAuthenticated } = useAuth0();

  useEffect(() => {
    setAccessTokenGetter(async () => {
      if (!isAuthenticated) return null;
      try {
        return await getAccessTokenSilently();
      } catch {
        return null;
      }
    });
  }, [getAccessTokenSilently, isAuthenticated]);

  return null;
}
