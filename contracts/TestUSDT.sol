// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// ─────────────────────────────────────────────────────────────────────────────
// TestUSDT — a throwaway 6-decimal stand-in for real Polygon USDT, for testing
// the Hordex platform on Polygon MAINNET without touching real funds.
//
// IMPORTANT: decimals = 6 to mirror real Polygon USDT
// (0xc2132D05D31c914a87C6611C10748AEb04B58e8F). This MUST stay in sync with the
// contract's USDT_ONE (= 1e6 in HordexTypes.sol) and the frontend's
// USDT_DECIMALS (= 6 in frontend/js/utils.js). If you change decimals here, flip
// those two as well.
//
// Minting is OPEN (anyone can mint / use the faucet) on purpose — this is a test
// token with no value. Do NOT use this pattern for a real asset.
//
// Deploy on Remix:  no constructor args; deployer receives INITIAL_SUPPLY.
// ─────────────────────────────────────────────────────────────────────────────

interface IERC20Rescue {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

contract TestUSDT {

    string public name     = "Test USDT";
    string public symbol   = "TUSDT";
    uint8  public decimals = 6;            // ← matches real Polygon USDT
    uint256 public totalSupply;

    address public owner;

    // One faucet pull = 10,000 TUSDT. Anyone can call faucet() to self-fund.
    uint256 public constant FAUCET_AMOUNT = 10_000 * 1e6;
    // Deployer premint = 100,000,000 TUSDT (plenty to seed the pool + fund tests).
    uint256 public constant INITIAL_SUPPLY = 100_000_000 * 1e6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Minted(address indexed to, uint256 amount);
    event Burned(address indexed from, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not the owner");
        _;
    }

    constructor() {
        owner = msg.sender;
        _mint(msg.sender, INITIAL_SUPPLY);
    }

    // ── ERC-20 CORE ──

    function transfer(address _to, uint256 _value) external returns (bool) {
        require(_to != address(0), "Invalid address");
        require(balanceOf[msg.sender] >= _value, "Insufficient balance");
        balanceOf[msg.sender] -= _value;
        balanceOf[_to] += _value;
        emit Transfer(msg.sender, _to, _value);
        return true;
    }

    function approve(address _spender, uint256 _value) external returns (bool) {
        allowance[msg.sender][_spender] = _value;
        emit Approval(msg.sender, _spender, _value);
        return true;
    }

    function transferFrom(address _from, address _to, uint256 _value) external returns (bool) {
        require(_to != address(0), "Invalid address");
        require(balanceOf[_from] >= _value, "Insufficient balance");
        require(allowance[_from][msg.sender] >= _value, "Allowance exceeded");
        allowance[_from][msg.sender] -= _value;
        balanceOf[_from] -= _value;
        balanceOf[_to] += _value;
        emit Transfer(_from, _to, _value);
        return true;
    }

    // ── FAUCET & MINT (open — test token only) ──

    // Anyone can pull FAUCET_AMOUNT to themselves to fund test investments.
    function faucet() external {
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    // Open mint of an arbitrary amount (amount is in base units, i.e. 6 decimals).
    function mint(address _to, uint256 _amount) external {
        require(_to != address(0), "Invalid address");
        _mint(_to, _amount);
    }

    function burn(uint256 _amount) external {
        require(balanceOf[msg.sender] >= _amount, "Insufficient balance");
        balanceOf[msg.sender] -= _amount;
        totalSupply -= _amount;
        emit Transfer(msg.sender, address(0), _amount);
        emit Burned(msg.sender, _amount);
    }

    function _mint(address _to, uint256 _amount) internal {
        totalSupply += _amount;
        balanceOf[_to] += _amount;
        emit Transfer(address(0), _to, _amount);
        emit Minted(_to, _amount);
    }

    // ── RESCUE (owner) ──

    function rescueToken(address _token, uint256 amount) external onlyOwner {
        uint256 bal = IERC20Rescue(_token).balanceOf(address(this));
        uint256 toSend = amount == 0 ? bal : (amount > bal ? bal : amount);
        require(toSend > 0, "Nothing to rescue");
        require(IERC20Rescue(_token).transfer(owner, toSend), "Transfer failed");
    }

    function rescueETH() external onlyOwner {
        uint256 bal = address(this).balance;
        require(bal > 0, "No ETH to rescue");
        (bool ok,) = payable(owner).call{value: bal}("");
        require(ok, "ETH transfer failed");
    }
}
