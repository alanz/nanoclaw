# DeltaChat RPC Server 2.48 Upgrade Notes

## API Spec Access

The OpenRPC spec is generated at runtime by the binary itself:

```bash
# Current installed version
node_modules/@deltachat/stdio-rpc-server-darwin-arm64/deltachat-rpc-server --openrpc

# Save to file
node_modules/@deltachat/stdio-rpc-server-darwin-arm64/deltachat-rpc-server --openrpc > openrpc.json

# Check version
node_modules/@deltachat/stdio-rpc-server-darwin-arm64/deltachat-rpc-server --version
```

The 2.48.0 spec is saved at `groups/main/memory/deltachat-rpc-server-2.48.0-openrpc.json`.

The current installed spec (1.160.0) has **153 methods**. Version 2.48.0 has **173 methods**.

---

## API Changes: 1.160.0 → 2.48.0

No existing method signatures changed — the upgrade is non-breaking for current usage.

### Added (26 methods)

#### WebRTC / Calling
Replaces `send_videochat_invitation` with a full call lifecycle API:

| Method | Description |
|--------|-------------|
| `place_outgoing_call` | Start an outgoing call |
| `accept_incoming_call` | Accept an incoming call |
| `end_call` | End incoming or outgoing call |
| `call_info` | Get information about a call |
| `ice_servers` | Return ICE servers JSON for WebRTC |

#### Broadcast Channels
| Method | Description |
|--------|-------------|
| `create_broadcast` | Create a new outgoing broadcast channel |
| `get_chat_description` | Load chat description from the database |
| `set_chat_description` | Set group or broadcast channel description |

#### Multi-Account
| Method | Description |
|--------|-------------|
| `forward_messages_to_account` | Forward messages to a chat in another account |
| `set_accounts_order` | Set the display order of accounts |

#### Events / Background Fetch
| Method | Description |
|--------|-------------|
| `get_next_event_batch` | Wait for at least one event and return a batch (replaces single-event polling) |
| `background_fetch` | Background fetch for all accounts in parallel (replaces `accounts_background_fetch`) |
| `stop_background_fetch` | Stop a background fetch |

#### Misc Utilities
| Method | Description |
|--------|-------------|
| `create_group_chat_unencrypted` | Create an unencrypted group chat |
| `create_qr_svg` | Render text as a QR code SVG image |
| `get_all_ui_config_keys` | Return all `ui.*` config keys set by the UI |
| `get_existing_msg_ids` | Check which message IDs exist |
| `get_message_read_receipt_count` | Return read receipt count on a message |
| `get_migration_error` | Get any error from account open/migration |
| `get_push_state` | Get current push notification state |
| `get_storage_usage_report_string` | Storage usage report as formatted string |
| `list_transports_ex` | List all email accounts used as transports |
| `markfresh_chat` | Mark last incoming message in a chat as fresh |
| `marknoticed_all_chats` | Mark all messages in all chats as noticed |
| `set_transport_unpublished` | Toggle whether a transport is unpublished |
| `secure_join_with_ux_info` | Like `secure_join` but with source and UI-path |

### Removed (6 methods)

| Method | Notes |
|--------|-------|
| `accounts_background_fetch` | Replaced by `background_fetch` |
| `send_videochat_invitation` | Replaced by the new call lifecycle methods |
| `initiate_autocrypt_key_transfer` | Autocrypt key transfer removed |
| `continue_autocrypt_key_transfer` | Autocrypt key transfer removed |
| `draft_self_report` | Removed |
| `reset_contact_encryption` | Removed |
