pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract DAOReputationProtocolFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public providers;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    mapping(uint256 => bool) public batchClosed;
    mapping(uint256 => mapping(address => euint32)) public encryptedReputationScores;
    mapping(uint256 => mapping(address => bool)) public hasSubmittedForBatch;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address account);
    event Unpaused(address account);
    event CooldownSecondsUpdated(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event ReputationSubmitted(address indexed provider, address indexed contributor, uint256 indexed batchId);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 totalScore);

    error NotOwner();
    error NotProvider();
    error PausedContract();
    error CooldownActive();
    error BatchClosedOrInvalid();
    error AlreadySubmitted();
    error ReplayDetected();
    error StateMismatch();
    error InvalidCleartextLength();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!providers[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedContract();
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        currentBatchId = 1;
        emit BatchOpened(currentBatchId);
        cooldownSeconds = 60; // Default cooldown
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        providers[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        providers[provider] = false;
            emit ProviderRemoved(provider);
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        uint256 oldCooldownSeconds = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsUpdated(oldCooldownSeconds, newCooldownSeconds);
    }

    function openNewBatch() external onlyOwner {
        currentBatchId++;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch(uint256 batchId) external onlyOwner {
        if (batchId == 0 || batchId > currentBatchId || batchClosed[batchId]) revert BatchClosedOrInvalid();
        batchClosed[batchId] = true;
        emit BatchClosed(batchId);
    }

    function submitReputation(
        address contributor,
        euint32 encryptedScore
    ) external onlyProvider whenNotPaused {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (batchClosed[currentBatchId]) revert BatchClosedOrInvalid();
        if (hasSubmittedForBatch[currentBatchId][contributor]) {
            revert AlreadySubmitted();
        }

        encryptedReputationScores[currentBatchId][contributor] = encryptedScore;
        hasSubmittedForBatch[currentBatchId][contributor] = true;
        lastSubmissionTime[msg.sender] = block.timestamp;

        emit ReputationSubmitted(msg.sender, contributor, currentBatchId);
    }

    function requestReputationAggregation(uint256 batchId) external onlyOwner whenNotPaused {
        if (batchId == 0 || batchId > currentBatchId || !batchClosed[batchId]) revert BatchClosedOrInvalid();
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(_aggregateBatchScores(batchId));

        bytes32 stateHash = keccak256(abi.encode(cts, address(this)));
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayDetected();

        uint256 batchId = decryptionContexts[requestId].batchId;
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(_aggregateBatchScores(batchId));
        bytes32 currentHash = keccak256(abi.encode(cts, address(this)));

        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        FHE.checkSignatures(requestId, cleartexts, proof);

        if (cleartexts.length != 32) revert InvalidCleartextLength();
        uint256 totalScore = uint256(bytes32(cleartexts));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, batchId, totalScore);
    }

    function _aggregateBatchScores(uint256 batchId) internal view returns (euint32) {
        euint32 totalScore = FHE.asEuint32(0);
        bool initialized = false;
        for (uint256 i = 0; i < 10; i++) { // Example: aggregate first 10 contributors for simplicity
            address contributor = address(uint160(i + 1)); // Example contributor addresses
            if (hasSubmittedForBatch[batchId][contributor]) {
                euint32 score = encryptedReputationScores[batchId][contributor];
                if (!initialized) {
                    totalScore = score;
                    initialized = true;
                } else {
                    totalScore = totalScore.add(score);
                }
            }
        }
        return initialized ? totalScore : FHE.asEuint32(0);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal view returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 value, bool initialized, euint32 initialValue) internal pure returns (euint32, bool) {
        if (!initialized) {
            return (initialValue, true);
        }
        return (value, initialized);
    }

    function _requireInitialized(bool initialized) internal pure {
        if (!initialized) {
            revert("FHE: Not initialized");
        }
    }
}