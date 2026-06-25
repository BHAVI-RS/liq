// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// ─────────────────────────────────────────────────────────────────────────────
// TEST-ONLY mock of a NON-STANDARD ERC-20 (e.g. canonical Ethereum/Polygon USDT)
// whose transfer / transferFrom / approve return NO data. Used solely to verify
// that Hordex's _safeTransfer / _safeTransferFrom helpers tolerate such tokens
// (the M-1 fix). NOT deployed by any production script.
// ─────────────────────────────────────────────────────────────────────────────
contract NoReturnUSDT {
    string public name     = "NoReturn USDT";
    string public symbol   = "NRUSDT";
    uint8  public decimals  = 6;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply   += amount;
        emit Transfer(address(0), to, amount);
    }

    // NOTE: deliberately returns NOTHING (non-standard), like real Tether USDT.
    function transfer(address to, uint256 value) external {
        require(balanceOf[msg.sender] >= value, "balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to]         += value;
        emit Transfer(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external {
        require(balanceOf[from] >= value, "balance");
        require(allowance[from][msg.sender] >= value, "allowance");
        allowance[from][msg.sender] -= value;
        balanceOf[from]             -= value;
        balanceOf[to]               += value;
        emit Transfer(from, to, value);
    }

    function approve(address spender, uint256 value) external {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
    }
}
