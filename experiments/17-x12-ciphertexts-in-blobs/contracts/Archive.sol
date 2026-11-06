// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

interface IBoard {
    function posts(uint256 seq) external view returns (bytes32 versionedHash, uint256 header);
}

/// Experiment 17 (X12): archivers who keep a board's blobs, and challenges that make keeping
/// enforceable. A challenge names an archiver and a recorded blob and pays a fee. Its point `z`
/// comes from the hash of the block the challenge was mined in, which nobody knows when the
/// challenge is sent, so answering takes the whole blob. The archiver answers with the blob's value
/// at `z` and a KZG proof, checked by the point-evaluation precompile against the versioned hash
/// the board recorded, and is paid the fee. An unanswered challenge pays the archiver's bond and
/// the fee to the challenger once `window` blocks have passed.
contract Archive {
    uint256 internal constant BLS_MODULUS = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001;
    address internal constant POINT_EVALUATION = address(0x0a);

    IBoard public immutable board;
    uint256 public immutable bondAmount;
    uint256 public immutable fee;
    uint256 public immutable window;

    struct Challenge {
        address archiver;
        address challenger;
        uint64 seq;
        uint64 block_;
        bool closed;
    }

    mapping(address => uint256) public bondOf;
    Challenge[] public challenges;

    event Bonded(address indexed archiver, uint256 amount);
    event Challenged(uint256 indexed id, address indexed archiver, uint256 seq, uint256 deadline);
    event Answered(uint256 indexed id, uint256 z, bytes32 y);
    event Slashed(uint256 indexed id, address indexed archiver, address challenger);

    constructor(IBoard board_, uint256 bondAmount_, uint256 fee_, uint256 window_) {
        board = board_;
        bondAmount = bondAmount_;
        fee = fee_;
        window = window_;
    }

    function bond() external payable {
        bondOf[msg.sender] += msg.value;
        emit Bonded(msg.sender, msg.value);
    }

    function challenge(address archiver, uint256 seq) external payable returns (uint256 id) {
        require(msg.value == fee, "fee");
        require(bondOf[archiver] >= bondAmount, "unbonded");
        (bytes32 vh, ) = board.posts(seq);
        require(vh != 0, "no such blob");
        id = challenges.length;
        challenges.push(Challenge(archiver, msg.sender, uint64(seq), uint64(block.number), false));
        emit Challenged(id, archiver, seq, block.number + window);
    }

    /// The point of challenge `id`: from the hash of its own block, so known only once it is mined.
    function zOf(uint256 id) public view returns (uint256) {
        Challenge storage c = challenges[id];
        require(block.number > c.block_, "too early");
        bytes32 h = blockhash(c.block_);
        require(h != 0, "too late");
        return uint256(keccak256(abi.encode(h, address(this), id, c.archiver, c.seq))) % BLS_MODULUS;
    }

    /// `kzg` is the blob's commitment (48 bytes) and the proof (48 bytes).
    function answer(uint256 id, bytes32 y, bytes calldata kzg) external {
        Challenge storage c = challenges[id];
        require(!c.closed, "closed");
        require(msg.sender == c.archiver, "not the archiver");
        require(block.number <= c.block_ + window, "late");
        require(kzg.length == 96, "kzg");
        uint256 z = zOf(id);
        (bytes32 vh, ) = board.posts(c.seq);
        (bool ok, bytes memory out) = POINT_EVALUATION.staticcall(abi.encodePacked(vh, z, y, kzg));
        require(ok && out.length == 64, "opening");
        c.closed = true;
        emit Answered(id, z, y);
        (bool paid, ) = msg.sender.call{value: fee}("");
        require(paid, "pay");
    }

    function slash(uint256 id) external {
        Challenge storage c = challenges[id];
        require(!c.closed, "closed");
        require(block.number > c.block_ + window, "in window");
        c.closed = true;
        bondOf[c.archiver] -= bondAmount;
        emit Slashed(id, c.archiver, c.challenger);
        (bool paid, ) = c.challenger.call{value: bondAmount + fee}("");
        require(paid, "pay");
    }
}
