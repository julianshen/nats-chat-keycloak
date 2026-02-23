package main

import (
	"fmt"

	"github.com/nats-io/jwt/v2"
)

// mapPermissions converts Keycloak realm roles into NATS permissions.
// username is used to scope the deliver.{username}.> subscription.
func mapPermissions(roles []string, username string) jwt.Permissions {
	perms := jwt.Permissions{
		Pub: jwt.Permission{},
		Sub: jwt.Permission{},
	}

	roleSet := make(map[string]bool)
	for _, r := range roles {
		roleSet[r] = true
	}

	deliverSubject := fmt.Sprintf("deliver.%s.>", username)

	if roleSet["admin"] {
		// Admins can pub/sub on all chat subjects and admin subjects
		perms.Pub.Allow = jwt.StringList{
			"chat.>",
			"admin.>",
			"room.join.*",
			"room.leave.*",
			"presence.update",
			"presence.heartbeat",
			"presence.disconnect",
			"presence.room.*",
			"read.update.*",
			"read.state.*",
			"users.search",
			"translate.request",
			"translate.ping",
			"stickers.products",
			"stickers.product.*",
			"app.*.*.>",
			"apps.list",
			"apps.room.*",
			"apps.install.*",
			"apps.uninstall.*",
			"_INBOX.>",
		}
		perms.Sub.Allow = jwt.StringList{
			deliverSubject,
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
			"room.join.*",
			"room.leave.*",
			"presence.update",
			"presence.heartbeat",
			"presence.disconnect",
			"presence.room.*",
			"read.update.*",
			"read.state.*",
			"users.search",
			"translate.request",
			"translate.ping",
			"stickers.products",
			"stickers.product.*",
			"app.*.*.>",
			"apps.list",
			"apps.room.*",
			"apps.install.*",
			"apps.uninstall.*",
			"_INBOX.>",
		}
		perms.Sub.Allow = jwt.StringList{
			deliverSubject,
			"_INBOX.>",
		}
		perms.Resp = &jwt.ResponsePermission{
			MaxMsgs: 1,
			Expires: 5 * 60 * 1000000000,
		}
	} else {
		// No recognized role: minimal permissions (read-only via fan-out delivery)
		perms.Pub.Allow = jwt.StringList{
			"chat.dms",
			"chat.history.>",
			"room.join.*",
			"room.leave.*",
			"presence.update",
			"presence.heartbeat",
			"presence.disconnect",
			"presence.room.*",
			"read.update.*",
			"read.state.*",
			"users.search",
			"translate.request",
			"translate.ping",
			"stickers.products",
			"stickers.product.*",
			"app.*.*.>",
			"apps.list",
			"apps.room.*",
			"_INBOX.>",
		}
		perms.Sub.Allow = jwt.StringList{
			deliverSubject,
			"_INBOX.>",
		}
		perms.Resp = &jwt.ResponsePermission{
			MaxMsgs: 1,
			Expires: 5 * 60 * 1000000000,
		}
	}

	return perms
}

// servicePermissions returns broad permissions for backend service accounts.
// All services run in the CHAT account and need full pub/sub access.
func servicePermissions() jwt.Permissions {
	return jwt.Permissions{
		Pub: jwt.Permission{Allow: jwt.StringList{">"}},
		Sub: jwt.Permission{Allow: jwt.StringList{">"}},
		Resp: &jwt.ResponsePermission{
			MaxMsgs: -1,
			Expires: 5 * 60 * 1000000000, // 5 minutes in nanoseconds
		},
	}
}
