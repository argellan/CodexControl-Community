# Connect GitHub to CodexControl

Author: Bishop Crockett · Owner: Argellan.com · License: MIT

Each user connects their own GitHub identity in **Projects → GitHub** and selects repositories for that project. Access requires both the user's GitHub permission and a CodexControl GitHub App installation covering the repository. Selecting a project or repository never grants additional GitHub access.

## Administrator setup

Register a GitHub App for your CodexControl deployment. Configure its callback as `https://YOUR-CONTROL-HOST/api/integrations/github/callback`. Enable expiring user access tokens. Use these repository permissions, all **read-only**: Metadata, Contents, Pull requests, Checks, Commit statuses, and Actions. Do not request write permissions. Install the App only on the repositories you intend to expose.

Store the App client secret in an owner-private file outside the release tree. Configure the authoritative hub's runtime JSON with `publicOrigin` and:

```json
{
  "githubApp": {
    "enabled": true,
    "appId": 12345,
    "clientId": "Iv1.REPLACE_WITH_APP_CLIENT_ID",
    "appSlug": "your-codexcontrol-app",
    "clientSecretFile": "/private/codexcontrol/github-client-secret"
  }
}
```

Use your actual registered App values. On Windows, use an absolute local path and restrict the file ACL to the service owner, SYSTEM, and Administrators. On Linux, use owner-only permissions. The service refuses unsafe storage. Users never paste private keys or personal access tokens into the dashboard. This user authorization flow does not require an App private key.

## User flow

1. Sign in to CodexControl with an individual account, open Projects, select a captured project, then open GitHub.
2. Choose **Connect GitHub**. GitHub handles authentication and consent.
3. On return, the same CodexControl browser session completes the connection. If needed, use **Authorize repositories on GitHub** to install the App or change its selected repositories, then refresh.
4. Select repositories and choose **Save project repositories**. Choose **View** beside a saved repository to retrieve its current branches, pull requests, checks, statuses, workflow runs, and artifact metadata.

The current repository view is fetched on demand with bounded pages. Its partial-coverage indicator is separate from the existing durable GitHub collector's captured history, which remains available below. No repository code, workflow logs, artifact files, or PR bodies are fetched. This connection does not start another background collector.

Disconnect clears the local credential first and attempts provider token revocation. If provider revocation cannot be confirmed, revoke access from GitHub's authorized applications settings. Reconnection is required after an interrupted token rotation. Account selection is private to each CodexControl user and project.

## Security and release checks

The flow uses random single-use state, PKCE S256, a fixed callback, and a final same-session confirmation. The cross-site callback cannot itself persist an account connection. Credentials remain in private server storage; response projections never expose tokens or the client secret. Every protected provider read checks current CodexControl authority and GitHub user/installation access. Redirects and arbitrary API targets are refused.

Mock-provider tests do not establish live GitHub App acceptance. Registering the App, consenting with a real account, and verifying the deployed callback remain explicit live acceptance steps. Normal source-bound performance and release gates still apply before deployment.

References: [GitHub App user tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), [user authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user).
