package main

import (
	"fmt"

	"github.com/nats-io/jwt/v2"
)

// E2EE publish permissions shared between admin and user roles.
var e2eePubPermissions = jwt.StringList{
	"e2ee.identity.publish",
	"e2ee.keys.get.*",
	"e2ee.roomkey.distribute",
	"e2ee.roomkey.raw",
	"e2ee.roomkey.get.*.*",
	"e2ee.roomkey.request.*",
	"e2ee.roomkey.rotate.*",
	"e2ee.room.enable.*",
	"e2ee.room.disable.*",
	"e2ee.room.meta.*",
	"e2ee.room.epoch.*",
}

// E2EE subscribe permissions shared between admin and user roles.
var e2eeSubPermissions = jwt.StringList{
	"e2ee.roomkey.request.*",
	"e2ee.roomkey.rotate.*",
}

// mapPermissions converts Keycloak realm roles into NATS permissions.
// Users publish messages via deliver.{username}.send.> (ingest path) and
// receive lightweight notifications via room.notify.* (ID stream).
// Full message content is fetched on demand via msg.get (permission-checked).
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
	sendSubject := fmt.Sprintf("deliver.%s.send.>", username)

	if roleSet["admin"] {
		// Admins can pub/sub on all chat subjects and admin subjects
		perms.Pub.Allow = append(jwt.StringList{
			sendSubject,    // Send messages via ingest path
			"admin.>",      // Admin room messages (direct publish, unchanged)
			"chat.history.>", // History requests (request/reply)
			"chat.dms",     // DM discovery (request/reply)
			"msg.get",      // Fetch message content (request/reply, permission-checked)
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
			"room.create",
			"room.list",
			"room.info.*",
			"room.invite.*",
			"room.kick.*",
			"room.depart.*",
			"_INBOX.>",
		}, e2eePubPermissions...)
		perms.Sub.Allow = append(jwt.StringList{
			deliverSubject,
			"room.notify.*",    // Message ID notifications (replaces room.msg.*)
			"room.presence.*",
			"_INBOX.>",
		}, e2eeSubPermissions...)
		// Allow response permissions for request/reply
		perms.Resp = &jwt.ResponsePermission{
			MaxMsgs: 1,
			Expires: 5 * 60 * 1000000000, // 5 minutes in nanoseconds
		}
	} else if roleSet["user"] {
		// Regular users can send messages and receive notifications
		perms.Pub.Allow = append(jwt.StringList{
			sendSubject,    // Send messages via ingest path
			"chat.history.>", // History requests (request/reply)
			"chat.dms",     // DM discovery (request/reply)
			"msg.get",      // Fetch message content (request/reply, permission-checked)
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
			"room.create",
			"room.list",
			"room.info.*",
			"room.invite.*",
			"room.kick.*",
			"room.depart.*",
			"_INBOX.>",
		}, e2eePubPermissions...)
		perms.Sub.Allow = append(jwt.StringList{
			deliverSubject,
			"room.notify.*",
			"room.presence.*",
			"_INBOX.>",
		}, e2eeSubPermissions...)
		perms.Resp = &jwt.ResponsePermission{
			MaxMsgs: 1,
			Expires: 5 * 60 * 1000000000,
		}
	} else {
		// No recognized role: minimal permissions (read-only via notifications)
		perms.Pub.Allow = jwt.StringList{
			"chat.dms",
			"chat.history.>",
			"msg.get",
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
			"room.list",
			"room.info.*",
			// E2EE read-only access
			"e2ee.identity.publish",
			"e2ee.keys.get.*",
			"e2ee.roomkey.get.*.*",
			"e2ee.room.meta.*",
			"_INBOX.>",
		}
		perms.Sub.Allow = jwt.StringList{
			deliverSubject,
			"room.notify.*",
			"room.presence.*",
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
