// A committed same-origin page restores SameSite=Strict session delivery after
// GitHub's cross-site callback. No callback code or state is copied forward.
window.location.replace('/?github=complete');
