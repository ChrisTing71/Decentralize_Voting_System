package votenet_test

import (
	"testing"

	keepertest "votenet/testutil/keeper"
	"votenet/testutil/nullify"
	votenet "votenet/x/votenet/module"
	"votenet/x/votenet/types"

	"github.com/stretchr/testify/require"
)

func TestGenesis(t *testing.T) {
	genesisState := types.GenesisState{
		Params: types.DefaultParams(),

		// this line is used by starport scaffolding # genesis/test/state
	}

	k, ctx := keepertest.VotenetKeeper(t)
	votenet.InitGenesis(ctx, k, genesisState)
	got := votenet.ExportGenesis(ctx, k)
	require.NotNil(t, got)

	nullify.Fill(&genesisState)
	nullify.Fill(got)

	// this line is used by starport scaffolding # genesis/test/assert
}
