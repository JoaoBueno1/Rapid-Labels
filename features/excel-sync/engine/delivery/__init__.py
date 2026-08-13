"""Delivery adapters — how a built block reaches its destination.

Same interface, swappable: `local_xlsx` writes a file on disk (which, inside a
synced OneDrive folder, publishes to SharePoint), `graph` will write through the
Microsoft Graph API once the Entra consent lands. The datasets, specs and
bindings above them do not change either way.
"""
