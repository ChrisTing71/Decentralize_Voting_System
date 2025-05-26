package keeper

import (
	"votenet/x/votenet/types"
)

var _ types.QueryServer = Keeper{}
