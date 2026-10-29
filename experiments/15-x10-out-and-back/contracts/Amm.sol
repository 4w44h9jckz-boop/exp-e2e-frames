// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

/// A test token anyone may mint: the output asset of experiment 15's swaps.
contract TestToken {
    string public constant name = "Experiment 15 token";
    string public constant symbol = "X15";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
}

interface IRegistry {
    function completeImport(uint256 value) external;
    function registerImportReceipt(address depositor, bytes32 value, bytes32 commitmentHash) external returns (bytes32);
}

/// A constant-product pool of ether and the token, 0.3 percent fee, whose reserves are its
/// balances. A private note reaches it as an export: the registry calls `onPrivateExport` with
/// the ether, and the pool pays the token to the registry and calls it back, either completing
/// the import at once (how 1) or registering a receipt for a later claim (how 2).
contract Amm {
    TestToken public immutable token;

    event Swapped(address indexed registry, uint256 amountIn, uint256 amountOut, uint256 how);

    constructor(TestToken token_) {
        token = token_;
    }

    /// Liquidity: the token is minted to the pool directly; ether is sent with this call.
    function addEther() external payable {}

    function quote(uint256 amountIn) public view returns (uint256) {
        uint256 x = address(this).balance;
        uint256 y = token.balanceOf(address(this));
        uint256 inWithFee = amountIn * 997;
        return (inWithFee * y) / (x * 1000 + inWithFee);
    }

    /// payload = minOut || how || partial (32 bytes each).
    function onPrivateExport(bytes calldata payload) external payable {
        (uint256 minOut, uint256 how, bytes32 partialNote) = abi.decode(payload, (uint256, uint256, bytes32));
        uint256 x = address(this).balance - msg.value;
        uint256 y = token.balanceOf(address(this));
        uint256 inWithFee = msg.value * 997;
        uint256 out = (inWithFee * y) / (x * 1000 + inWithFee);
        require(out >= minOut, "slippage");
        token.transfer(msg.sender, out);
        if (how == 1) {
            IRegistry(msg.sender).completeImport(out);
        } else if (how == 2) {
            IRegistry(msg.sender).registerImportReceipt(msg.sender, bytes32(out), partialNote);
        } else {
            revert("how");
        }
        emit Swapped(msg.sender, msg.value, out, how);
    }
}

/// Destinations that misbehave, one way each, for experiment 15's refusals.
contract Probe {
    TestToken public immutable token;
    uint256 public immutable kind;
    Relay public immutable relay;

    constructor(TestToken token_, uint256 kind_, Relay relay_) {
        token = token_;
        kind = kind_;
        relay = relay_;
    }

    function onPrivateExport(bytes calldata payload) external payable {
        (uint256 minOut,,) = abi.decode(payload, (uint256, uint256, bytes32));
        if (kind == 0) {
            // Underpay: claim minOut without paying any token in.
            IRegistry(msg.sender).completeImport(minOut);
        } else if (kind == 1) {
            // Twice: pay, complete, and complete again.
            token.mint(msg.sender, 2 * minOut);
            IRegistry(msg.sender).completeImport(minOut);
            IRegistry(msg.sender).completeImport(minOut);
        } else if (kind == 2) {
            // Through another contract: pay, then have a relay call back.
            token.mint(msg.sender, minOut);
            relay.relay(IRegistry(msg.sender), minOut);
        } else {
            // Silent: keep the ether and never call back.
        }
    }
}

contract Relay {
    function relay(IRegistry registry, uint256 value) external {
        registry.completeImport(value);
    }
}
