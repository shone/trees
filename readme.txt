Year -> year of simulation
Cell -> forest patch (10mx10m) on which the tree stands (here from 1 to 5000, we usually visualize only 25 maximum)
SLA -> "specific leaf area", measure for leaf thickness, determines the color of the canopy, could be a rainbow color scale or range from very dark green (low values) to light green (high values)
Wooddens -> "wood density", determines the color of the trunk, could range from light brown (low values) to dark brown (high values)
Longevity -> "leaf longevity", anticorrelates with SLA, doesn't need to be plotted
PFT -> "Plant Functional Type", could determine the shape of the crown (e.g. broad-leaved trees -> spheric, needle-leaved trees -> conic) 
	0: Broad-leaved summergreen tree (e.g. oak or beech)
	1: Broad-leaved evergreen tree (e.g. holm oak)
	2: Boreal needle-leaved evergreen tree (e.g. scots pine, norway spruce)
	3: Temperate needle-leaved evergreen tree (e.g. allepo pine, pinus negras)
Biomass -> Biomass of the tree, doesn't need to be plotted
Height -> tree height to the middle of the canopy
Age -> correlates with tree height, doesn't need to be plotted

General remarks:
- trees do not have a precise position within a forest patch, needs to be assigned randomly with data preprocessing
- SLA, Longevity and Wooddens remain fixed of the whole lifetime of a tree. Their combination is very specific for a tree and can be therefore used to identify a tree in the next year
- crowns size correlates with tree height (Maik will look up the relation between tree height and crown size)
- in the model crown shapes are assumed to be cylinders. Therefore, plotting cylinders as crowns could be a first step. :)