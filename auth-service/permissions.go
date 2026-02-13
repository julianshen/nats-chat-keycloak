package main

import (
	"github.com/nats-io/jwt/v2"
)

// mapPermissions converts Keycloak realm roles into NATS permissions.
func mapPermissions(roles []string) jwt.Permissions {
	perms := jwt.Permissions{
		Pub: jwt.Permission{},
		Sub: jwt.Permission{},
	}

	roleSet := make(map[string]bool)
	for _, r := range roles {
		roleSet[r] = true
	}

	if roleSet["admin"] {
		// Admins can pub/sub on all chat subjects and admin subjects
		perms.Pub.Allow = jwt.StringList{
			"chat.>",
			"admin.>",
			"_INBOX.>",
		}
		perms.Sub.Allow = jwt.StringList{
			"chat.>",
			"admin.>",
			"_INBOX.>",
		}
		// Allow response permissions for request/reply
		perms.Resp = &jwt.ResponsePermission{
			MaxMsgs: 1,
			Expires: 5 * 60 * 1000000000, // 5 minutes in nanoseconds
		}
	} else if roleSet["user"] {
		// Regular users can pub/sub on chat subjects only
		perms.Pub.Allow = jwt.StringList{
			"chat.>",
			"_INBOX.>",
		}
		perms.Sub.Allow = jwt.StringList{
			"chat.>",
			"_INBOX.>",
		}
		perms.Resp = &jwt.ResponsePermission{
			MaxMsgs: 1,
			Expires: 5 * 60 * 1000000000,
		}
	} else {
		// No recognized role: minimal permissions (effectively read-only on public)
		perms.Pub.Allow = jwt.StringList{
			"_INBOX.>",
		}
		perms.Sub.Allow = jwt.StringList{
			"chat.>",
			"_INBOX.>",
		}
	}

	return perms
}
