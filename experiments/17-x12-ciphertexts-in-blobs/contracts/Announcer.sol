// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

/// Experiment 17 (X12), the baseline: each ciphertext as a log. `announce` is ERC-5564's, with its
/// event; `announceNote` puts an encrypted note's bytes in a log the same way.
contract Announcer {
    /// ERC-5564's event, as its reference announcer emits it.
    event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata);
    event NoteAnnounced(address indexed caller, bytes ciphertext);

    function announce(uint256 schemeId, address stealthAddress, bytes memory ephemeralPubKey, bytes memory metadata) external {
        emit Announcement(schemeId, stealthAddress, msg.sender, ephemeralPubKey, metadata);
    }

    function announceNote(bytes calldata ciphertext) external {
        emit NoteAnnounced(msg.sender, ciphertext);
    }
}
