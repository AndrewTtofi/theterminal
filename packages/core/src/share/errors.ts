/**
 * The share view's refusals, in one module so the share service, the link manager and the route error map all use
 * the same classes. Every message is fixed text: none ever carries a path, an id or anything the request sent.
 */

/** The preview id is unknown: never made, already saved, evicted, or made for another project. */
export class PreviewNotFoundError extends Error {
  constructor() {
    super("no such preview");
    this.name = "PreviewNotFoundError";
  }
}

/** The preview expired, or the hash sent is not the hash of the page that was previewed. */
export class PreviewStaleError extends Error {
  constructor() {
    super("the preview has changed or expired");
    this.name = "PreviewStaleError";
  }
}

export class SnapshotMissingError extends Error {
  constructor() {
    super("the snapshot file is missing");
    this.name = "SnapshotMissingError";
  }
}

/** The saved file's sha256 is not the hash its share.confirmed entry recorded. */
export class SnapshotTamperedError extends Error {
  constructor() {
    super("the snapshot file does not match the ledger");
    this.name = "SnapshotTamperedError";
  }
}

export class ShareTooLargeError extends Error {
  constructor() {
    super("the share page is too large");
    this.name = "ShareTooLargeError";
  }
}

/** Task 5's link manager: one live link per project. */
export class ShareLinkActiveError extends Error {
  constructor() {
    super("a share link is already live for this project");
    this.name = "ShareLinkActiveError";
  }
}

/** Task 5's link manager: the address is not one the server offered. */
export class AddressNotAllowedError extends Error {
  constructor() {
    super("that address cannot be used");
    this.name = "AddressNotAllowedError";
  }
}

/** Task 5's link manager: revoking a link that is not live. */
export class LinkNotActiveError extends Error {
  constructor() {
    super("the link is not live");
    this.name = "LinkNotActiveError";
  }
}
