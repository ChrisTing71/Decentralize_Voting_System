package keeper_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	keepertest "votenet/testutil/keeper"
	"votenet/x/votenet/types"
)

func TestGetParams(t *testing.T) {
	k, ctx := keepertest.VotenetKeeper(t)
	params := types.DefaultParams()

	require.NoError(t, k.SetParams(ctx, params))
	require.EqualValues(t, params, k.GetParams(ctx))
}
